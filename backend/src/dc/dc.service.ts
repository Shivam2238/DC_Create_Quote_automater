import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Level, Phase } from './activity.service';
import { HTTP_MARKER, RemoteRunnerService } from './remote-runner.service';
import { SshPoolService } from './ssh-pool.service';
import { SshSession, spawnOnce } from './ssh-session.service';

export type Action = 'quote' | 'payloads' | 'all';
export type PayloadKind = 'request' | 'response';

export interface QuoteResult {
  success: boolean;
  quoteNumber?: string;
  premium?: string;
  isPremiumMatched?: string;
  cohortType?: string;
  /** HTTP status of the create-quote call, when curl got that far. */
  httpStatus?: number;
  raw: unknown;
}

export interface PayloadResult {
  kind: PayloadKind;
  status: 'saved' | 'null' | 'not-json';
  /** File name in the payloads dir (served by GET /api/files/:name). */
  file?: string;
  size?: number;
}

/**
 * Why a policy failed:
 * - connection: our side (SSH session, network, timeout). Usually fine to retry.
 * - server:     the create-quote service/gateway failed (5xx, non-JSON). Retry may work.
 * - api:        the API/data said no (is_success false, no api_logs row). Retrying won't help.
 * - input:      something we were given is wrong (e.g. Postgres password).
 * - stopped:    stopped by the user from the UI.
 */
export type FailureKind = 'connection' | 'server' | 'api' | 'input' | 'stopped';

export interface Failure {
  kind: FailureKind;
  reason: string;
  step: 'connect' | 'quote' | 'payload';
  /** The create-quote request may have reached the API, so a retry could create a second quote. */
  mayHaveRun: boolean;
}

export const RETRYABLE: FailureKind[] = ['connection', 'server'];

/** Step reporting for the live activity view. `phase` updates the session card; every call is logged. */
export type Progress = (msg: string, opts?: { phase?: Phase; level?: Level }) => void;

export interface RunResult {
  policy: string;
  quote?: QuoteResult;
  payloads?: PayloadResult[];
  /** When create-quote failed: the error found in DuckCreek's own external_response. */
  externalError?: string;
}

const ERROR_KEY = /message|error|fault|exception|detail|description|reason/i;
const ERROR_TEXT = /deadlock|exception|error|fail|timeout|invalid|not found|violat|denied|rerun|unable|cannot/i;

/**
 * Pull the human-readable error(s) out of a DuckCreek external_response: strings under
 * message/error/fault/exception-like keys that read like an error, plus anything
 * mentioning a deadlock. The wrapper's E012 hides these.
 */
export function summarizeExternal(value: unknown): string | undefined {
  const found: string[] = [];
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 12 || found.length >= 6) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t && ((ERROR_KEY.test(key) && ERROR_TEXT.test(t)) || /deadlock/i.test(t) || /error|fault|exception/i.test(key))) {
        const clean = t.replace(/\s+/g, ' ').slice(0, 300);
        if (!found.includes(clean)) found.push(clean);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key, depth + 1));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    }
  };
  walk(value, '', 0);
  return found.length ? found.join(' | ').slice(0, 900) : undefined;
}

export interface RunOutcome {
  result: RunResult;
  failure?: Failure;
}

/** Columns hold JSON as text, sometimes double-encoded: unwrap until it's not a string. */
function deepJson(value: unknown): unknown {
  while (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

// curl exit codes: https://curl.se/libcurl/c/libcurl-errors.html
const CURL_NOT_SENT = new Set([5, 6, 7, 35, 60]); // proxy/DNS/connect/TLS: request never reached the API
const CURL_MAYBE_SENT = new Set([18, 28, 52, 55, 56, 92]); // timeout/empty reply/send-recv errors mid-request

/** Classify a failed remote step from the job's exit code and stderr. */
function classifyRemote(step: 'quote' | 'payload', code: number, stderr: string): Failure {
  const text = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
  if (step === 'quote') {
    const m = stderr.match(/curl: \((\d+)\)/);
    const curlCode = m ? Number(m[1]) : code;
    if (CURL_NOT_SENT.has(curlCode)) {
      return { kind: 'connection', step, mayHaveRun: false, reason: `Could not reach the create-quote API: ${text}` };
    }
    return {
      kind: 'connection',
      step,
      mayHaveRun: CURL_MAYBE_SENT.has(curlCode) || !m,
      reason: `Connection to the create-quote API broke: ${text}`,
    };
  }
  if (/password authentication failed/i.test(stderr)) {
    return { kind: 'input', step, mayHaveRun: false, reason: 'Postgres password is wrong' };
  }
  if (/could not connect|connection refused|timeout expired|server closed the connection|no route to host|SSL/i.test(stderr)) {
    return { kind: 'connection', step, mayHaveRun: false, reason: `Could not reach Postgres: ${text}` };
  }
  return { kind: 'connection', step, mayHaveRun: false, reason: `Postgres query failed: ${text}` };
}

/** "message [errorCode]: detail; detail" — the detail is where e.g. DuckCreek deadlocks show up. */
function apiMessage(resp: any): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const msg = resp?.message ?? resp?.error ?? resp?.data?.message ?? resp?.errors;
  if (!msg) return JSON.stringify(resp).slice(0, 300);
  const code = resp?.errorCode ? ` [${resp.errorCode}]` : '';
  const detail = resp?.detailedErrorMessage;
  const details = Array.isArray(detail) ? detail.map(str).join('; ') : detail ? str(detail) : '';
  return `${str(msg)}${code}${details ? `: ${details}` : ''}`.slice(0, 600);
}

/**
 * Transient create-quote failures that are safe to retry automatically: DB deadlocks
 * (the losing transaction is rolled back), E012 "quote missing in response", and
 * gateway 502/503/504. Timeouts are excluded: the original call may still create a quote.
 */
export function isTransient(f: Failure): boolean {
  if (f.kind !== 'server' || f.step !== 'quote') return false;
  if (/didn't respond/i.test(f.reason)) return false;
  return /deadlock|\[E012\]|missing in response|HTTP 50[234]|Service Unavailable/i.test(f.reason);
}

@Injectable()
export class DcService {
  constructor(
    private readonly runner: RemoteRunnerService,
    private readonly pool: SshPoolService,
    private readonly config: ConfigService,
  ) {}

  get outDir(): string {
    // Empty DC_OUT_DIR in .env counts as unset; default is <project root>/payloads.
    return path.resolve(this.config.get<string>('DC_OUT_DIR') || path.join(__dirname, '..', '..', '..', 'payloads'));
  }

  get pgPasswordConfigured(): boolean {
    return !!this.config.get('DC_PG_PASSWORD');
  }

  /**
   * Runs one policy on the given session. Policy-level failures come back as
   * `failure` (with whatever succeeded before it in `result`); only session-level
   * problems (connect failure, session lost, timeout) are thrown.
   */
  async run(
    policy: string,
    action: Action,
    session: SshSession,
    pgPassword?: string,
    progress: Progress = () => undefined,
  ): Promise<RunOutcome> {
    if (!/^\d+$/.test(policy ?? '')) throw new BadRequestException('policy number must be digits only');
    if (!['quote', 'payloads', 'all'].includes(action)) throw new BadRequestException('invalid action');

    const wantQuote = action !== 'payloads';
    const wantPayloads = action !== 'quote';
    const password = pgPassword || this.config.get<string>('DC_PG_PASSWORD');
    if (wantPayloads && !password) throw new BadRequestException('postgres password required');

    const seen = new Set<string>();
    const out = await this.runner.run(
      this.runner.buildScript(policy, wantQuote, wantPayloads, password),
      session,
      (edge, tag) => {
        seen.add(`${edge}_${tag}`);
        if (tag === 'QUOTE' && edge === 'BEGIN') progress('Calling create-quote API (curl)…', { phase: 'quote' });
        if (tag === 'QUOTE' && edge === 'END') progress('create-quote API responded');
        if (tag === 'PAYLOAD' && edge === 'BEGIN') progress(`Querying ${this.runner.apiLogsTable} in Postgres (psql)…`, { phase: 'payload' });
        if (tag === 'PAYLOAD' && edge === 'END') progress('Postgres query returned');
      },
    );

    const result: RunResult = { policy };
    let failure: Failure | undefined;

    if (wantQuote && out.quote !== undefined) {
      const q = (result.quote = this.parseQuote(out.quote));
      if (q.success) {
        progress(`Quote ${q.quoteNumber} created (premium ${q.premium}, matched ${q.isPremiumMatched === '1' ? 'yes' : 'no'})`, {
          level: 'success',
        });
      } else {
        failure = this.classifyQuote(q);
        progress(`create-quote failed: ${failure.reason}`, { level: 'warn' });
      }
    }

    if (out.code !== 0) {
      // The script stopped at the step that failed (set -e).
      const step = seen.has('BEGIN_PAYLOAD') && !seen.has('END_PAYLOAD') ? 'payload' : 'quote';
      failure ??= classifyRemote(step, out.code, out.stderr);
      progress(failure.reason, { level: 'error' });
      return { result, failure };
    }

    if (wantPayloads && out.payload !== undefined) {
      progress('Parsing and saving payload files…', { phase: 'saving' });
      result.payloads = await this.savePayloads(policy, out.payload);
      const missing = result.payloads.filter((p) => p.status === 'null').map((p) => p.kind);
      if (missing.length === 2) {
        failure ??= { kind: 'api', step: 'payload', mayHaveRun: false, reason: `No ${this.runner.apiLogsTable} row for this policy` };
      } else if (missing.length) {
        failure ??= { kind: 'api', step: 'payload', mayHaveRun: false, reason: `external_${missing[0]} is NULL in ${this.runner.apiLogsTable}` };
      }
      const saved = result.payloads.map((p) => `${p.kind}: ${p.status}`).join(', ');
      progress(`Payloads ${saved}`, { level: missing.length ? 'warn' : 'success' });
      if (result.quote && !result.quote.success) {
        result.externalError = await this.externalSummary(result.payloads);
        if (result.externalError) progress(`DuckCreek response: ${result.externalError}`, { level: 'warn' });
      }
    }
    return { result, failure };
  }

  /** Error text from a saved external_response file (see summarizeExternal). */
  async externalSummary(payloads?: PayloadResult[]): Promise<string | undefined> {
    const file = payloads?.find((p) => p.kind === 'response' && p.file)?.file;
    if (!file) return undefined;
    try {
      const text = await fs.readFile(path.join(this.outDir, file), 'utf8');
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // raw text response: summarise as-is
      }
      return summarizeExternal(value) ?? (typeof value === 'string' ? value.slice(0, 300) : undefined);
    } catch {
      return undefined;
    }
  }

  private classifyQuote(q: QuoteResult): Failure {
    const status = q.httpStatus ?? 0;
    if (status >= 500 || status === 0 || typeof q.raw === 'string') {
      const what = status ? `HTTP ${status}` : 'no HTTP status';
      const body = typeof q.raw === 'string' ? q.raw.slice(0, 200) : apiMessage(q.raw);
      return {
        kind: 'server',
        step: 'quote',
        // A gateway timeout/5xx can happen after the wrapper already created the quote.
        mayHaveRun: true,
        reason: `create-quote service error (${what}): ${body}`,
      };
    }
    return { kind: 'api', step: 'quote', mayHaveRun: true, reason: `API rejected (HTTP ${status}): ${apiMessage(q.raw)}` };
  }

  private parseQuote(raw: string): QuoteResult {
    let httpStatus: number | undefined;
    const i = raw.lastIndexOf(HTTP_MARKER);
    if (i >= 0) {
      httpStatus = Number(raw.slice(i + HTTP_MARKER.length).trim()) || undefined;
      raw = raw.slice(0, i).trim();
    }
    let resp: any;
    try {
      resp = JSON.parse(raw);
    } catch {
      return { success: false, httpStatus, raw };
    }
    const data = resp?.data ?? {};
    return {
      success: !!resp?.is_success && !!data.quote_number,
      quoteNumber: data.quote_number,
      premium: data.premium,
      isPremiumMatched: data.is_premium_matched,
      cohortType: data.cohort_type,
      httpStatus,
      raw: resp,
    };
  }

  private async savePayloads(policy: string, raw: string): Promise<PayloadResult[]> {
    const row = JSON.parse(raw) as Record<PayloadKind, unknown>;
    await fs.mkdir(this.outDir, { recursive: true });

    const results: PayloadResult[] = [];
    for (const kind of ['request', 'response'] as PayloadKind[]) {
      const value = deepJson(row[kind]);
      if (value === null || value === undefined) {
        results.push({ kind, status: 'null' });
      } else {
        const isJson = typeof value !== 'string';
        const file = `${policy}_${kind}_payload.${isJson ? 'json' : 'txt'}`;
        const text = isJson ? JSON.stringify(value, null, 2) + '\n' : (value as string);
        await fs.writeFile(path.join(this.outDir, file), text);
        results.push({ kind, status: isJson ? 'saved' : 'not-json', file, size: Buffer.byteLength(text) });
      }
    }
    return results;
  }

  async listFiles(): Promise<{ name: string; size: number; modified: string }[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.outDir);
    } catch {
      return [];
    }
    const files = await Promise.all(
      names
        .filter((n) => /^\d+_(request|response)_payload\.(json|txt)$/.test(n))
        .map(async (name) => {
          const st = await fs.stat(path.join(this.outDir, name));
          return { name, size: st.size, modified: st.mtime.toISOString() };
        }),
    );
    return files.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  filePath(name: string): string {
    // Only serve files we wrote; the regex also blocks path traversal.
    if (!/^\d+_(request|response)_payload\.(json|txt)$/.test(name)) throw new NotFoundException();
    return path.join(this.outDir, name);
  }

  async status() {
    const local = this.config.get('DC_LOCAL') === 'true';
    let gcloud = { ok: local, account: '', detail: local ? 'local mode, gcloud not used' : '' };
    if (!local) {
      try {
        const r = await spawnOnce('gcloud', ['auth', 'print-access-token', '--quiet'], 20000);
        const acct = await spawnOnce('gcloud', ['config', 'get-value', 'account'], 20000);
        gcloud = {
          ok: r.code === 0,
          account: acct.stdout.trim(),
          detail: r.code === 0 ? 'authenticated' : 'auth expired: run `gcloud auth login`',
        };
      } catch (e) {
        gcloud = { ok: false, account: '', detail: `gcloud unavailable: ${(e as Error).message}` };
      }
    }
    return {
      gcloud,
      vm: {
        name: this.config.get<string>('DC_VM_NAME') || 'instance-1',
        zone: this.config.get('DC_VM_ZONE', ''),
        project: this.config.get('DC_VM_PROJECT', ''),
        local,
      },
      sessions: this.pool.info(),
      pgPasswordConfigured: this.pgPasswordConfigured,
      outDir: this.outDir,
    };
  }
}
