import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarkerListener, SshSession } from './ssh-session.service';

// Environment-specific values come from backend/.env (not committed); read at use time.
const env = (key: string) => process.env[key]?.trim() ?? '';
export const API_LOGS_TABLE = () => env('DC_API_LOGS_TABLE') || 'api_logs';

const begin = (tag: string) => `__DC_BEGIN_${tag}__`;
const end = (tag: string) => `__DC_END_${tag}__`;

/** POSIX single-quote escaping, equivalent to Python's shlex.quote. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export interface RemoteSections {
  quote?: string;
  payload?: string;
}

/**
 * Builds the manual VM workflow script (cd into DC_WORK_DIR, which holds the
 * psql SSL certs -> curl create-quote and/or psql api_logs) and runs it in the
 * given pooled SSH session. Scripts go over stdin, so the DB password never hits argv.
 */
@Injectable()
export class RemoteRunnerService {
  constructor(private readonly config: ConfigService) {}

  buildScript(policy: string, wantQuote: boolean, wantPayloads: boolean, pgPassword?: string): string {
    const lines = ['set -e', `cd ${shq(env('DC_WORK_DIR'))}`];
    if (wantPayloads) lines.push(`export PGPASSWORD=${shq(pgPassword ?? '')}`);

    if (wantQuote) {
      const body = JSON.stringify({ policyNumber: policy, forceCreateQuote: true });
      lines.push(
        `echo ${begin('QUOTE')}`,
        `curl -sS --location ${shq(env('DC_CREATE_QUOTE_URL'))} --header 'Content-Type: application/json' --data ${shq(body)}`,
        `echo; echo ${end('QUOTE')}`,
      );
    }

    if (wantPayloads) {
      // Same semantics as the two manual "latest row" queries; json_build_object
      // escapes the stored text so it comes back as one safe line.
      const latest = (col: string) =>
        `(select ${col} from ${API_LOGS_TABLE()} where policy_number='${policy}' order by created_at desc limit 1)`;
      const sql =
        `select json_build_object('request', ${latest('external_request')}, ` +
        `'response', ${latest('external_response')});`;
      lines.push(
        `echo ${begin('PAYLOAD')}`,
        `psql ${shq(env('DC_PG_CONN'))} -X -At -v ON_ERROR_STOP=1 -c ${shq(sql)}`,
        `echo ${end('PAYLOAD')}`,
      );
    }
    return lines.join('\n') + '\n';
  }

  async run(script: string, session: SshSession, onMarker?: MarkerListener): Promise<RemoteSections> {
    const timeout = (Number(this.config.get('DC_TIMEOUT_SECONDS')) || 180) * 1000;
    const { code, stdout, stderr } = await session.exec(script, timeout, onMarker);
    if (code !== 0) {
      throw new Error(`remote command failed (exit ${code}): ${stderr || stdout}`);
    }
    return { quote: extract(stdout, 'QUOTE'), payload: extract(stdout, 'PAYLOAD') };
  }
}

function extract(output: string, tag: string): string | undefined {
  const m = output.match(new RegExp(`${begin(tag)}\\n([\\s\\S]*?)\\n?${end(tag)}`));
  return m ? m[1].trim() : undefined;
}
