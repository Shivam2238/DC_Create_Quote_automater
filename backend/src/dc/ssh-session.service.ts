import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { ActivityService } from './activity.service';

export type SessionState = 'disconnected' | 'connecting' | 'connected';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The session died. `started` = the job's BEGIN marker had come back, i.e. it may have run. */
export class SessionLostError extends Error {
  constructor(
    message: string,
    readonly started: boolean,
  ) {
    super(message);
  }
}

/** Called as section markers (`__DC_BEGIN_QUOTE__`, `__DC_END_PAYLOAD__`, ...) stream in. */
export type MarkerListener = (edge: 'BEGIN' | 'END', tag: string) => void;

interface Pending {
  id: string;
  started: boolean;
  onMarker?: MarkerListener;
  scanPos: number;
  resolve: (r: ExecResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Runs a command once and collects its output (used for gcloud auth checks). */
export function spawnOnce(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * One long-lived `gcloud compute ssh <vm> --command 'sudo bash -s'` process.
 * Scripts are written to its stdin one at a time; each runs in a subshell
 * (so `set -e` / failures don't kill the session) and is framed by unique
 * markers so its stdout, stderr and exit code can be cut out of the stream.
 *
 * Not re-entrant: one job at a time per session. SshPoolService owns N of these
 * and JobQueueService gives each session its own worker.
 */
export class SshSession {
  private readonly logger: Logger;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderrTail = '';
  private pending?: Pending;
  private connecting?: Promise<void>;
  private shuttingDown = false;

  state: SessionState = 'disconnected';
  lastError = '';
  connectedAt?: Date;

  /**
   * @param beforeOpen awaited before this session opens; the pool uses it so extra
   *        sessions wait until one has connected (see SshPoolService).
   */
  constructor(
    readonly id: number,
    private readonly config: ConfigService,
    private readonly activity: ActivityService,
    private readonly beforeOpen?: () => Promise<void>,
  ) {
    this.logger = new Logger(`SshSession#${id}`);
  }

  private log(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
    this.activity.log(msg, { level, session: this.id });
  }

  close() {
    this.shuttingDown = true;
    if (this.child) this.drop(this.child, 'server shutting down');
  }

  get isLocal(): boolean {
    return this.config.get('DC_LOCAL') === 'true';
  }

  private command(): [string, string[]] {
    if (this.isLocal) return ['sudo', ['bash', '-s']];

    const args = ['compute', 'ssh', this.config.get<string>('DC_VM_NAME') || 'instance-1'];
    const zone = this.config.get<string>('DC_VM_ZONE');
    const project = this.config.get<string>('DC_VM_PROJECT');
    if (zone) args.push('--zone', zone);
    if (project) args.push('--project', project);
    const extra = (this.config.get<string>('DC_SSH_FLAGS') || '').trim();
    if (extra) args.push(...extra.split(/\s+/));
    args.push(
      '--quiet', // never prompt (e.g. for zone) and hang
      '--ssh-flag=-T', // no tty: plain stdin pipe
      '--ssh-flag=-o ServerAliveInterval=30',
      '--ssh-flag=-o ServerAliveCountMax=4',
      '--command',
      'sudo bash -s',
    );
    return ['gcloud', args];
  }

  /** Ensure a live session, starting one if needed. Concurrent callers share the attempt. */
  connect(): Promise<void> {
    if (this.state === 'connected' && this.child) return Promise.resolve();
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<void> {
    this.state = 'connecting';
    if (this.beforeOpen) {
      this.activity.set(this.id, 'connecting', 'Waiting for session #1 to connect first');
      try {
        await this.beforeOpen();
      } catch (e) {
        this.state = 'disconnected';
        this.lastError = `waiting for first session: ${(e as Error).message}`;
        this.activity.set(this.id, 'disconnected', 'Could not connect');
        this.log(this.lastError, 'error');
        throw new Error(this.lastError);
      }
    }
    const [file, args] = this.command();
    this.logger.log(`opening session: ${file} ${args.join(' ')}`);
    const target = this.isLocal ? 'local sudo bash' : `gcloud compute ssh ${args[2]}`;
    this.activity.set(this.id, 'connecting', `Opening SSH session (${target})`);
    this.log(`Opening SSH session: ${target}`);
    this.state = 'connecting';
    this.lastError = '';
    this.buffer = '';
    this.stderrTail = '';

    // Own process group, so drop() can kill gcloud *and* the ssh it spawns.
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onStdout(d));
    child.stderr.on('data', (d: string) => this.onStderr(d));
    child.stdin.on('error', () => undefined); // EPIPE when the process dies; handled on 'close'
    child.on('error', (e) => this.onClose(child, `failed to start ${file}: ${e.message}`));
    child.on('close', (code) => this.onClose(child, `session exited (code ${code})`));

    // Round-trip a no-op: proves ssh is up, sudo works and the shell is reading stdin.
    const connectTimeout = (Number(this.config.get('DC_CONNECT_TIMEOUT_SECONDS')) || 90) * 1000;
    try {
      await this.send('true', connectTimeout);
    } catch (e) {
      this.drop(child, (e as Error).message);
      throw new Error(this.lastError);
    }
    this.state = 'connected';
    this.connectedAt = new Date();
    this.logger.log('session connected');
    this.activity.set(this.id, 'idle', 'Idle, waiting for jobs');
    this.log('Connected (root shell on the VM)', 'success');
  }

  /** gcloud/ssh chatter: shown live while connecting (key propagation etc.), as warnings afterwards. */
  private onStderr(chunk: string) {
    this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    for (const line of chunk.split(/\r?\n/).map((l) => l.trim())) {
      // Job stderr goes to a temp file, so anything here is from gcloud/ssh itself.
      if (line) this.log(`gcloud: ${line}`, this.state === 'connecting' ? 'info' : 'warn');
    }
  }

  /** Mark the session dead now (don't wait for pipes to close) and kill its process group. */
  private drop(child: ChildProcessWithoutNullStreams, reason: string) {
    this.onClose(child, reason);
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }

  private onClose(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return; // already dropped / replaced
    const detail = this.stderrTail.trim().split('\n').slice(-5).join('\n');
    this.child = undefined;
    this.state = 'disconnected';
    this.connectedAt = undefined;
    if (!this.shuttingDown) {
      this.lastError = detail ? `${reason}: ${detail}` : reason;
      this.logger.warn(this.lastError);
      this.activity.set(this.id, 'disconnected', 'Disconnected; reconnects on its next job');
      this.log(`Session closed: ${reason}`, 'error');
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new SessionLostError(this.lastError || reason, this.pending.started));
      this.pending = undefined;
    }
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    const p = this.pending;
    if (!p) return;
    if (!p.started && this.buffer.includes(`__DC_JOB_BEGIN_${p.id}__`)) p.started = true;
    if (p.onMarker) {
      // Report section markers as they arrive, so the UI sees each step start/finish live.
      const re = /__DC_(BEGIN|END)_([A-Z]+)__\n/g;
      re.lastIndex = p.scanPos;
      let mk: RegExpExecArray | null;
      while ((mk = re.exec(this.buffer))) {
        p.scanPos = re.lastIndex;
        p.onMarker(mk[1] as 'BEGIN' | 'END', mk[2]);
      }
    }
    const m = this.buffer.match(
      new RegExp(`__DC_JOB_BEGIN_${p.id}__\\n([\\s\\S]*?)__DC_JOB_ERR_${p.id}__\\n([\\s\\S]*?)__DC_JOB_END_${p.id}__(\\d+)\\n`),
    );
    if (!m) return;
    this.buffer = this.buffer.slice((m.index ?? 0) + m[0].length);
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve({ stdout: m[1].replace(/\n$/, ''), stderr: m[2].trim(), code: Number(m[3]) });
  }

  /** Run a script in the session. Resolves with its own stdout/stderr/exit code. */
  async exec(script: string, timeoutMs: number, onMarker?: MarkerListener): Promise<ExecResult> {
    await this.connect();
    try {
      return await this.send(script, timeoutMs, onMarker);
    } catch (e) {
      // Session was already dead when we wrote (e.g. network drop not yet noticed) and
      // the job never started: safe to replay once on a fresh session.
      if (!(e instanceof SessionLostError) || e.started) throw e;
      this.logger.warn(`session lost before job started (${e.message}); reconnecting and retrying`);
      this.log('Session was lost before the job started; reconnecting and retrying once', 'warn');
      await this.connect();
      return this.send(script, timeoutMs, onMarker);
    }
  }

  private send(script: string, timeoutMs: number, onMarker?: MarkerListener): Promise<ExecResult> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(this.lastError || 'session not connected'));
    if (this.pending) return Promise.reject(new Error('session busy'));

    const id = randomBytes(6).toString('hex');
    // stdin of the job is /dev/null so nothing inside can swallow later jobs from our pipe.
    const framed = [
      `__dc_err=$(mktemp)`,
      `echo __DC_JOB_BEGIN_${id}__`,
      `(`,
      script.trimEnd(),
      `) </dev/null 2>"$__dc_err"`,
      `__dc_rc=$?`,
      `echo; echo __DC_JOB_ERR_${id}__; cat "$__dc_err"; rm -f "$__dc_err"`,
      `echo; echo "__DC_JOB_END_${id}__$__dc_rc"`,
      '',
    ].join('\n');

    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Can't interrupt one command in the remote shell reliably; recycle the session.
        // drop() rejects this pending job; the next job reconnects.
        this.drop(child, `job timed out after ${timeoutMs / 1000}s, session will reconnect`);
      }, timeoutMs);
      this.pending = { id, started: false, onMarker, scanPos: this.buffer.length, resolve, reject, timer };
      child.stdin.write(framed);
    });
  }
}
