import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Level, Phase } from './activity.service';
import {
  deepJson,
  ERROR_SOURCE_KINDS,
  parseQuoteFields,
  PAYLOAD_KINDS,
  payloadFileName,
  Product,
  PRODUCT_INFO,
  productOf,
  QuoteFields,
  SERVED_FILE,
  splitPayloadRows,
} from './products';
import { HTTP_MARKER, RemoteRunnerService } from './remote-runner.service';
import { SshPoolService } from './ssh-pool.service';
import { SshSession, spawnOnce } from './ssh-session.service';

export type Action = 'quote' | 'payloads' | 'all';
/** Health: request/response. Motor: dc_request/dc_response/blaze_request/blaze_response. */
export type PayloadKind = string;

export interface QuoteResult extends QuoteFields {
  success: boolean;
  /** HTTP status of the create-quote call, when curl got that far. */
  httpStatus?: number;
  /** Wrapper response (small ones inline)… */
  raw?: unknown;
  /** …or saved to this file when large (Motor returns the whole DuckCreek session). */
  rawFile?: string;
}

/** Wrapper responses bigger than this are written to a file instead of kept in the job. */
const INLINE_RAW_LIMIT = 20_000;

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
  const add = (t: string) => {
    const clean = t.replace(/\s+/g, ' ').slice(0, 300);
    if (!found.includes(clean)) found.push(clean);
  };
  // inError: we're inside an error/fault/exception/processingerrors block, where any
  // message-like string is the explanation (e.g. "Vehicle IDV is outside the allowed range").
  const walk = (v: unknown, key: string, depth: number, inError: boolean) => {
    if (depth > 14 || found.length >= 6) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return;
      if (
        /deadlock/i.test(t) ||
        (ERROR_KEY.test(key) && (inError || ERROR_TEXT.test(t))) ||
        /error|fault|exception/i.test(key)
      ) {
        add(t);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key, depth + 1, inError));
    } else if (v && typeof v === 'object') {
      // DuckCreek Motor attaches schema warnings even to good responses; skip them when validation passed.
      if (key === 'ApiValidation' && (v as any).validationStatus === true) return;
      for (const [k, x] of Object.entries(v)) {
        walk(x, k, depth + 1, inError || /error|fault|exception/i.test(k));
      }
    }
  };
  walk(value, '', 0, false);
  return found.length ? found.join(' | ').slice(0, 900) : undefined;
}

export interface RunOutcome {
  result: RunResult;
  failure?: Failure;
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
  const str = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));
  if (resp === undefined || resp === null) return 'empty response';
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
    product: Product,
    policy: string,
    action: Action,
    session: SshSession,
    pgPassword?: string,
    progress: Progress = () => undefined,
  ): Promise<RunOutcome> {
    if (!/^\d+$/.test(policy ?? '')) throw new BadRequestException('policy number must be digits only');
    if (productOf(policy) !== product) {
      throw new BadRequestException(`${PRODUCT_INFO[product].label} policy numbers start with ${PRODUCT_INFO[product].prefix}`);
    }
    if (!['quote', 'payloads', 'all'].includes(action)) throw new BadRequestException('invalid action');

    const wantQuote = action !== 'payloads';
    const wantPayloads = action !== 'quote';
    const password = pgPassword || this.config.get<string>('DC_PG_PASSWORD');
    if (wantPayloads && !password) throw new BadRequestException('postgres password required');

    const seen = new Set<string>();
    const out = await this.runner.run(
      this.runner.buildScript(product, policy, wantQuote, wantPayloads, password),
      session,
      this.runner.timeoutMs(product),
      (edge, tag) => {
        seen.add(`${edge}_${tag}`);
        if (tag === 'QUOTE' && edge === 'BEGIN') {
          progress(product === 'motor' ? 'Calling create-quote API (Blaze rating → DuckCreek)…' : 'Calling create-quote API (curl)…', {
            phase: 'quote',
          });
        }
        if (tag === 'QUOTE' && edge === 'END') progress('create-quote API responded');
        if (tag === 'PAYLOAD' && edge === 'BEGIN') progress(`Querying ${this.runner.apiLogsTable} in Postgres (psql)…`, { phase: 'payload' });
        if (tag === 'PAYLOAD' && edge === 'END') progress('Postgres query returned');
      },
    );

    const result: RunResult = { policy };
    let failure: Failure | undefined;

    if (wantQuote && out.quote !== undefined) {
      const { quote: q, resp } = await this.parseQuote(product, policy, out.quote);
      result.quote = q;
      if (q.success) {
        const extra = product === 'health' ? `, matched ${q.isPremiumMatched === '1' ? 'yes' : 'no'}` : q.purePremium ? `, pure ${q.purePremium} + tax ${q.taxes}` : '';
        progress(`Quote ${q.quoteNumber} created (premium ${q.premium}${extra})`, { level: 'success' });
      } else {
        failure = this.classifyQuote(product, q, resp);
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
      const { payloads, dcMissing, note } = await this.savePayloads(product, policy, out.payload);
      result.payloads = payloads;
      failure ??= this.payloadFailure(product, payloads, dcMissing);
      const saved = payloads.map((p) => `${p.kind}: ${p.status}`).join(', ');
      progress(`Payloads ${saved}${note ? ` (${note})` : ''}`, { level: failure?.step === 'payload' ? 'warn' : 'success' });
      if ((result.quote && !result.quote.success) || failure?.step === 'payload') {
        result.externalError = await this.externalSummary(payloads);
        if (result.externalError) progress(`External response: ${result.externalError}`, { level: 'warn' });
      }
    }
    return { result, failure };
  }

  /** Missing api_logs data is an "api" failure (retrying the lookup won't conjure a row). */
  private payloadFailure(product: Product, payloads: PayloadResult[], dcMissing?: boolean): Failure | undefined {
    const table = this.runner.apiLogsTable;
    const has = (k: string) => payloads.some((p) => p.kind === k && p.status !== 'null');
    const fail = (reason: string): Failure => ({ kind: 'api', step: 'payload', mayHaveRun: false, reason });
    if (product === 'health') {
      if (!has('request') && !has('response')) return fail(`No ${table} row for this policy`);
      if (!has('request')) return fail(`external_request is NULL in ${table}`);
      if (!has('response')) return fail(`external_response is NULL in ${table}`);
      return undefined;
    }
    if (!payloads.some((p) => p.status !== 'null')) return fail(`No ${table} rows for this policy`);
    if (dcMissing) return fail('Latest attempt has only a Blaze row: the DuckCreek call was not reached (or not logged)');
    if (!has('dc_response')) return fail(`DuckCreek external_response is NULL in ${table}`);
    if (!has('blaze_response')) return fail(`No Blaze row found before the DuckCreek row in ${table}`);
    return undefined;
  }

  /** Error text from a saved external_response file (see summarizeExternal). */
  async externalSummary(payloads?: PayloadResult[]): Promise<string | undefined> {
    const file = ERROR_SOURCE_KINDS.map((k) => payloads?.find((p) => p.kind === k && p.file)?.file).find(Boolean);
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

  /** `resp` is the parsed wrapper response (q.raw may have been moved to a file). */
  private classifyQuote(product: Product, q: QuoteResult, resp: unknown): Failure {
    const status = q.httpStatus ?? 0;
    // Motor: HTTP 200 + is_success but no QuoteNumber means DuckCreek answered without a quote.
    if (product === 'motor' && status >= 200 && status < 300 && (resp as any)?.is_success) {
      const why = summarizeExternal((resp as any)?.data) ?? 'no QuoteNumber in the DuckCreek response';
      return { kind: 'api', step: 'quote', mayHaveRun: true, reason: `DuckCreek returned no quote: ${why}` };
    }
    if (status >= 500 || status === 0 || typeof resp === 'string') {
      const what = status ? `HTTP ${status}` : 'no HTTP status';
      const body = typeof resp === 'string' ? resp.slice(0, 200) : apiMessage(resp);
      return {
        kind: 'server',
        step: 'quote',
        // A gateway timeout/5xx can happen after the wrapper already created the quote,
        // except a Motor failure at the Blaze step: DuckCreek is only called after Blaze.
        mayHaveRun: !(product === 'motor' && /blaze/i.test(body)),
        reason: `create-quote service error (${what}): ${body}`,
      };
    }
    return { kind: 'api', step: 'quote', mayHaveRun: true, reason: `API rejected (HTTP ${status}): ${apiMessage(resp)}` };
  }

  private async parseQuote(product: Product, policy: string, raw: string): Promise<{ quote: QuoteResult; resp: unknown }> {
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
      return { quote: { success: false, httpStatus, ...(await this.keepRaw(product, policy, raw)) }, resp: raw };
    }
    const fields = parseQuoteFields(product, resp);
    const quote: QuoteResult = {
      success: !!resp?.is_success && !!fields.quoteNumber,
      ...fields,
      httpStatus,
      ...(await this.keepRaw(product, policy, resp)),
    };
    return { quote, resp };
  }

  /** Keep small wrapper responses inline; write big ones (Motor's full session) to a file. */
  private async keepRaw(product: Product, policy: string, value: unknown): Promise<Pick<QuoteResult, 'raw' | 'rawFile'>> {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text.length <= INLINE_RAW_LIMIT) return { raw: value };
    const file = payloadFileName(product, policy, 'quote_response', typeof value === 'string' ? 'txt' : 'json');
    await fs.mkdir(path.dirname(path.join(this.outDir, file)), { recursive: true });
    await fs.writeFile(path.join(this.outDir, file), text + '\n');
    return { rawFile: file };
  }

  private async savePayloads(
    product: Product,
    policy: string,
    raw: string,
  ): Promise<{ payloads: PayloadResult[]; dcMissing?: boolean; note?: string }> {
    const { values, dcMissing, note } = splitPayloadRows(product, raw);
    const results: PayloadResult[] = [];
    for (const kind of PAYLOAD_KINDS[product]) {
      const value = deepJson(values[kind]);
      if (value === null || value === undefined) {
        results.push({ kind, status: 'null' });
        continue;
      }
      const isJson = typeof value !== 'string';
      const file = payloadFileName(product, policy, kind, isJson ? 'json' : 'txt');
      const text = isJson ? JSON.stringify(value, null, 2) + '\n' : (value as string);
      await fs.mkdir(path.dirname(path.join(this.outDir, file)), { recursive: true });
      await fs.writeFile(path.join(this.outDir, file), text);
      results.push({ kind, status: isJson ? 'saved' : 'not-json', file, size: Buffer.byteLength(text) });
    }
    return { payloads: results, dcMissing, note };
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
        .filter((n) => SERVED_FILE.test(n))
        .map(async (name) => {
          const st = await fs.stat(path.join(this.outDir, name));
          return { name, size: st.size, modified: st.mtime.toISOString() };
        }),
    );
    return files.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  filePath(name: string): string {
    // Only serve files we wrote; the regex also blocks path traversal.
    if (!SERVED_FILE.test(name)) throw new NotFoundException();
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
