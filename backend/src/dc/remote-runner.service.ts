import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarkerListener, SshSession } from './ssh-session.service';

const begin = (tag: string) => `__DC_BEGIN_${tag}__`;
const end = (tag: string) => `__DC_END_${tag}__`;

/** POSIX single-quote escaping, equivalent to Python's shlex.quote. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export interface RemoteOutput {
  /** Section bodies; undefined when that section never finished (e.g. curl/psql failed). */
  quote?: string;
  payload?: string;
  /** Exit code of the job script and its stderr (curl/psql error text). */
  code: number;
  stderr: string;
}

export const HTTP_MARKER = '__DC_HTTP__';

/**
 * Builds the manual VM workflow script (cd into DC_WORK_DIR, which holds the psql
 * SSL certs -> curl create-quote and/or psql api_logs) and runs it in the given
 * pooled SSH session. Scripts go over stdin, so the DB password never hits argv.
 *
 * Environment-specific values (paths, URLs, DB connection) come from backend/.env,
 * which is not committed.
 */
@Injectable()
export class RemoteRunnerService {
  constructor(private readonly config: ConfigService) {}

  private required(key: string): string {
    const v = this.config.get<string>(key)?.trim();
    if (!v) throw new BadRequestException(`${key} is not set in backend/.env (see .env.example)`);
    return v;
  }

  /** Schema-qualified api_logs table; validated because it's interpolated into SQL. */
  get apiLogsTable(): string {
    const t = this.config.get<string>('DC_API_LOGS_TABLE')?.trim() || 'api_logs';
    if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)?$/.test(t)) throw new BadRequestException(`invalid DC_API_LOGS_TABLE: ${t}`);
    return t;
  }

  buildScript(policy: string, wantQuote: boolean, wantPayloads: boolean, pgPassword?: string): string {
    const lines = ['set -e', `cd ${shq(this.required('DC_WORK_DIR'))}`];
    if (wantPayloads) lines.push(`export PGPASSWORD=${shq(pgPassword ?? '')}`);

    if (wantQuote) {
      const body = JSON.stringify({ policyNumber: policy, forceCreateQuote: true });
      lines.push(
        `echo ${begin('QUOTE')}`,
        // --write-out appends the HTTP status so gateway errors (5xx) can be told apart from API rejections.
        `curl -sS --location ${shq(this.required('DC_CREATE_QUOTE_URL'))} --header 'Content-Type: application/json' --data ${shq(body)} --write-out '\n${HTTP_MARKER}%{http_code}'`,
        `echo; echo ${end('QUOTE')}`,
      );
    }

    if (wantPayloads) {
      // Same semantics as the two manual "latest row" queries; json_build_object
      // escapes the stored text so it comes back as one safe line.
      const latest = (col: string) =>
        `(select ${col} from ${this.apiLogsTable} where policy_number='${policy}' order by created_at desc limit 1)`;
      const sql =
        `select json_build_object('request', ${latest('external_request')}, ` +
        `'response', ${latest('external_response')});`;
      lines.push(
        `echo ${begin('PAYLOAD')}`,
        `psql ${shq(this.required('DC_PG_CONN'))} -X -At -v ON_ERROR_STOP=1 -c ${shq(sql)}`,
        `echo ${end('PAYLOAD')}`,
      );
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Runs the script; a non-zero exit is returned (not thrown) so the caller can keep
   * whatever finished before the failure. Throws only if the session itself fails.
   */
  async run(script: string, session: SshSession, onMarker?: MarkerListener): Promise<RemoteOutput> {
    const timeout = (Number(this.config.get('DC_TIMEOUT_SECONDS')) || 180) * 1000;
    const { code, stdout, stderr } = await session.exec(script, timeout, onMarker);
    return { quote: extract(stdout, 'QUOTE'), payload: extract(stdout, 'PAYLOAD'), code, stderr };
  }
}

function extract(output: string, tag: string): string | undefined {
  const m = output.match(new RegExp(`${begin(tag)}\\n([\\s\\S]*?)\\n?${end(tag)}`));
  return m ? m[1].trim() : undefined;
}
