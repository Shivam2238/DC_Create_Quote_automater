import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Level, Phase } from './activity.service';
import { API_LOGS_TABLE, RemoteRunnerService } from './remote-runner.service';
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
  raw: unknown;
}

export interface PayloadResult {
  kind: PayloadKind;
  status: 'saved' | 'null' | 'not-json';
  file?: string;
  content?: unknown;
}

/** Step reporting for the live activity view. `phase` updates the session card; every call is logged. */
export type Progress = (msg: string, opts?: { phase?: Phase; level?: Level }) => void;

export interface RunResult {
  policy: string;
  quote?: QuoteResult;
  payloads?: PayloadResult[];
  message?: string;
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

  async run(
    policy: string,
    action: Action,
    session: SshSession,
    pgPassword?: string,
    progress: Progress = () => undefined,
  ): Promise<RunResult> {
    if (!/^\d+$/.test(policy ?? '')) throw new BadRequestException('policy number must be digits only');
    if (!['quote', 'payloads', 'all'].includes(action)) throw new BadRequestException('invalid action');

    const wantQuote = action !== 'payloads';
    const wantPayloads = action !== 'quote';
    const password = pgPassword || this.config.get<string>('DC_PG_PASSWORD');
    if (wantPayloads && !password) throw new BadRequestException('postgres password required');

    const sections = await this.runner.run(
      this.runner.buildScript(policy, wantQuote, wantPayloads, password),
      session,
      (edge, tag) => {
        if (tag === 'QUOTE' && edge === 'BEGIN') progress('Calling create-quote API (curl)…', { phase: 'quote' });
        if (tag === 'QUOTE' && edge === 'END') progress('create-quote API responded');
        if (tag === 'PAYLOAD' && edge === 'BEGIN') progress(`Querying ${API_LOGS_TABLE()} in Postgres (psql)…`, { phase: 'payload' });
        if (tag === 'PAYLOAD' && edge === 'END') progress('Postgres query returned');
      },
    );

    const result: RunResult = { policy };
    if (wantQuote) {
      const q = (result.quote = this.parseQuote(sections.quote ?? ''));
      if (q.success) progress(`Quote ${q.quoteNumber} created (premium ${q.premium}, matched ${q.isPremiumMatched === '1' ? 'yes' : 'no'})`, { level: 'success' });
      else progress('create-quote did not return a quote number', { level: 'warn' });
    }
    if (wantPayloads) {
      if (sections.payload) {
        progress('Parsing and saving payload files…', { phase: 'saving' });
        result.payloads = await this.savePayloads(policy, sections.payload);
        const saved = result.payloads.map((p) => `${p.kind}: ${p.status}`).join(', ');
        progress(`Payloads ${saved}`, { level: result.payloads.some((p) => p.status !== 'saved') ? 'warn' : 'success' });
      } else {
        result.message = `no rows in ${API_LOGS_TABLE()}`;
        progress(result.message, { level: 'warn' });
      }
    }
    return result;
  }

  private parseQuote(raw: string): QuoteResult {
    let resp: any;
    try {
      resp = JSON.parse(raw);
    } catch {
      return { success: false, raw };
    }
    const data = resp?.data ?? {};
    return {
      success: !!resp?.is_success && !!data.quote_number,
      quoteNumber: data.quote_number,
      premium: data.premium,
      isPremiumMatched: data.is_premium_matched,
      cohortType: data.cohort_type,
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
      } else if (typeof value === 'string') {
        const file = path.join(this.outDir, `${policy}_${kind}_payload.txt`);
        await fs.writeFile(file, value);
        results.push({ kind, status: 'not-json', file, content: value });
      } else {
        const file = path.join(this.outDir, `${policy}_${kind}_payload.json`);
        await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
        results.push({ kind, status: 'saved', file, content: value });
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
