import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ActivityService, Phase } from './activity.service';
import { Action, DcService, Failure, RETRYABLE, RunResult } from './dc.service';
import { SshPoolService } from './ssh-pool.service';
import { SessionLostError, spawnOnce } from './ssh-session.service';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Attempt {
  attempt: number;
  action: Action;
  session?: number;
  finishedAt: string;
  failure: Failure;
}

export interface Job {
  id: string;
  batchId: string;
  policy: string;
  /** What the batch asked for. */
  action: Action;
  /** What the current/last attempt ran (a retry after a created quote only re-fetches payloads). */
  runAction: Action;
  state: JobState;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  session?: number;
  result?: RunResult;
  failure?: Failure;
  /** Earlier failed attempts, oldest first. */
  history: Attempt[];
}

export interface Batch {
  id: string;
  name: string;
  action: Action;
  createdAt: string;
  finishedAt?: string;
  jobs: Job[];
}

export type BatchStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BatchSummary {
  id: string;
  name: string;
  action: Action;
  createdAt: string;
  finishedAt?: string;
  status: BatchStatus;
  total: number;
  succeeded: number;
  failed: number;
  /** Failed for connection/server reasons: worth retrying. */
  retryable: number;
  running: number;
  queued: number;
  cancelled: number;
}

const MAX_BATCHES = 100;

function defaultBatchName(d = new Date()): string {
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour12: false });
  return `${date} · ${time}`;
}

const isActive = (j: Job) => j.state === 'queued' || j.state === 'running';
const needsPassword = (a: Action) => a !== 'quote';

/**
 * Batches of policies on top of the SSH pool. Every submission is a batch; its
 * jobs go into one FIFO queue with one worker per session (the same policy never
 * runs on two sessions at once). Batches persist to DC_DATA_DIR/batches.json;
 * Postgres passwords stay in memory only, until the job runs.
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private batches: Batch[] = [];
  private readonly passwords = new Map<string, string>();
  private queue: Job[] = [];
  private readonly busySessions = new Set<number>(); // pool indexes with a job in flight
  private readonly runningPolicies = new Set<string>();
  /** Running jobs being stopped → whether to put them back in the queue, and why. */
  private readonly stopRequests = new Map<string, { requeue: boolean; why: string }>();
  /** While true, nothing new is handed to sessions (VM reconnect in progress). */
  private paused = false;
  vmBusy: '' | 'reconnecting' | 'disconnecting' = '';
  private saveTimer?: NodeJS.Timeout;

  constructor(
    private readonly dc: DcService,
    private readonly pool: SshPoolService,
    private readonly config: ConfigService,
    private readonly activity: ActivityService,
  ) {}

  // ---------------------------------------------------------------- persistence

  private get file(): string {
    const dir = this.config.get<string>('DC_DATA_DIR') || path.join(__dirname, '..', '..', '..', 'data');
    return path.join(path.resolve(dir), 'batches.json');
  }

  onModuleInit() {
    if (!existsSync(this.file)) return;
    try {
      this.batches = JSON.parse(readFileSync(this.file, 'utf8')) as Batch[];
      // Keep the state we started from, in case something goes wrong this run.
      if (this.batches.length) copyFileSync(this.file, `${this.file}.bak`);
    } catch (e) {
      this.logger.error(`could not read ${this.file}: ${(e as Error).message}`);
      return;
    }
    // Anything unfinished when the server stopped can't resume (passwords aren't stored).
    const now = new Date().toISOString();
    for (const b of this.batches) {
      for (const j of b.jobs.filter(isActive)) {
        const wasRunning = j.state === 'running';
        j.state = 'failed';
        j.finishedAt = now;
        j.failure = {
          kind: 'connection',
          step: wasRunning ? 'quote' : 'connect',
          mayHaveRun: wasRunning && j.runAction !== 'payloads',
          reason: wasRunning
            ? 'The console server restarted while this policy was running'
            : 'The console server restarted before this policy ran',
        };
      }
      b.finishedAt ??= now;
    }
    this.logger.log(`loaded ${this.batches.length} batches from ${this.file}`);
  }

  onModuleDestroy() {
    clearTimeout(this.saveTimer);
    this.writeNow();
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeNow(), 300);
  }

  private writeNow() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.batches));
      renameSync(tmp, this.file);
    } catch (e) {
      this.logger.error(`could not save batches: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- queries

  get pending(): number {
    return this.queue.length + this.busySessions.size;
  }

  summaries(): BatchSummary[] {
    return [...this.batches].reverse().map((b) => this.summarize(b));
  }

  get(id: string): { summary: BatchSummary; jobs: Job[] } {
    const b = this.find(id);
    return { summary: this.summarize(b), jobs: b.jobs };
  }

  private find(id: string): Batch {
    const b = this.batches.find((x) => x.id === id);
    if (!b) throw new NotFoundException('batch not found');
    return b;
  }

  private summarize(b: Batch): BatchSummary {
    const count = (s: JobState) => b.jobs.filter((j) => j.state === s).length;
    const failed = count('failed');
    const cancelled = count('cancelled');
    const running = count('running');
    const queued = count('queued');
    const status: BatchStatus = running + queued ? 'running' : failed ? 'failed' : cancelled ? 'cancelled' : 'succeeded';
    return {
      id: b.id,
      name: b.name,
      action: b.action,
      createdAt: b.createdAt,
      finishedAt: b.finishedAt,
      status,
      total: b.jobs.length,
      succeeded: count('succeeded'),
      failed,
      retryable: b.jobs.filter((j) => j.state === 'failed' && j.failure && RETRYABLE.includes(j.failure.kind)).length,
      running,
      queued,
      cancelled,
    };
  }

  // ---------------------------------------------------------------- commands

  create(policies: string[], action: Action, name?: string, pgPassword?: string) {
    const list = [...new Set((policies ?? []).map((p) => String(p).trim()).filter(Boolean))];
    if (!list.length) throw new BadRequestException('no policy numbers given');
    const bad = list.filter((p) => !/^\d+$/.test(p));
    if (bad.length) throw new BadRequestException(`policy number must be digits only: ${bad.join(', ')}`);
    if (!['quote', 'payloads', 'all'].includes(action)) throw new BadRequestException('invalid action');
    this.requirePassword(action, pgPassword);

    const now = new Date();
    const batch: Batch = {
      id: randomUUID(),
      name: name?.trim().slice(0, 100) || defaultBatchName(now),
      action,
      createdAt: now.toISOString(),
      jobs: [],
    };
    batch.jobs = list.map<Job>((policy) => ({
      id: randomUUID(),
      batchId: batch.id,
      policy,
      action,
      runAction: action,
      state: 'queued',
      attempts: 0,
      createdAt: batch.createdAt,
      history: [],
    }));
    this.batches.push(batch);
    this.trim();
    this.enqueue(batch.jobs, pgPassword);
    this.activity.log(`Batch "${batch.name}" started: ${list.length} polic${list.length === 1 ? 'y' : 'ies'} (${action})`, {
      batch: batch.id,
    });
    this.save();
    this.dispatch();
    return this.get(batch.id);
  }

  rename(id: string, name: string) {
    const clean = String(name ?? '').trim().slice(0, 100);
    if (!clean) throw new BadRequestException('name cannot be empty');
    const b = this.find(id);
    b.name = clean;
    this.save();
    return this.summarize(b);
  }

  remove(id: string) {
    const b = this.find(id);
    if (b.jobs.some(isActive)) throw new BadRequestException('cancel or wait for the batch to finish before deleting it');
    this.batches = this.batches.filter((x) => x !== b);
    this.activity.log(`Batch "${b.name}" deleted (${b.jobs.length} policies)`, { level: 'warn' });
    this.logger.log(`batch deleted: ${b.name}`);
    this.save();
  }

  cancel(id: string): number {
    const b = this.find(id);
    const queued = b.jobs.filter((j) => j.state === 'queued');
    const now = new Date().toISOString();
    for (const j of queued) {
      j.state = 'cancelled';
      j.finishedAt = now;
      this.passwords.delete(j.id);
    }
    this.queue = this.queue.filter((j) => j.state === 'queued');
    if (queued.length) {
      this.activity.log(`Cancelled ${queued.length} queued polic${queued.length === 1 ? 'y' : 'ies'} in "${b.name}"`, {
        level: 'warn',
        batch: b.id,
      });
      this.finishBatchIfDone(b);
      this.save();
    }
    return queued.length;
  }

  /**
   * Stop one policy. Running: its SSH session is killed (and reconnects for the next
   * job). Queued: it's taken out of the queue. With `requeue`, it goes to the back of
   * the queue instead of ending as "stopped".
   */
  stop(batchId: string, jobId: string, requeue: boolean) {
    const b = this.find(batchId);
    const job = b.jobs.find((j) => j.id === jobId);
    if (!job) throw new NotFoundException('policy not found in this batch');

    if (job.state === 'queued') {
      if (requeue) {
        // Move to the back of the line.
        this.queue = this.queue.filter((j) => j !== job);
        this.queue.push(job);
        this.activity.log('Moved to the back of the queue', { policy: job.policy, batch: b.id });
      } else {
        this.queue = this.queue.filter((j) => j !== job);
        this.passwords.delete(job.id);
        job.state = 'cancelled';
        job.finishedAt = new Date().toISOString();
        job.failure = { kind: 'stopped', step: 'connect', mayHaveRun: false, reason: 'Removed from the queue before it ran' };
        this.activity.log('Removed from the queue', { level: 'warn', policy: job.policy, batch: b.id });
        this.finishBatchIfDone(b);
      }
      this.save();
      return this.get(b.id);
    }
    if (job.state !== 'running') throw new BadRequestException('only queued or running policies can be stopped');

    const session = this.pool.sessions.find((s) => s.id === job.session);
    this.activity.log(requeue ? 'Stopping and re-queueing…' : 'Stopping…', {
      level: 'warn',
      session: job.session,
      policy: job.policy,
      batch: b.id,
    });
    this.stopRequests.set(job.id, { requeue, why: 'Stopped by user' });
    session?.abort(requeue ? 'stopped by user (re-queued)' : 'stopped by user');
    return this.get(b.id);
  }

  // ---------------------------------------------------------------- whole-VM connection

  /**
   * Drop every SSH session and log in to the VM again. Running policies are
   * stopped and put back in the queue; the queue resumes once #1 is connected.
   */
  async reconnectVm(): Promise<string> {
    if (this.vmBusy) throw new BadRequestException(`already ${this.vmBusy}`);
    await this.checkGcloudAuth();
    this.vmBusy = 'reconnecting';
    try {
      const interrupted = await this.stopAllAndClose('VM reconnect requested', 'Reconnecting to the VM…');
      this.activity.log(`Reconnecting to the VM${interrupted ? ` (${interrupted} running polic${interrupted === 1 ? 'y' : 'ies'} put back in the queue)` : ''}…`, {
        level: 'warn',
      });
      await this.pool.connectFirst();
      await this.vmHealthCheck();
      return 'reconnected';
    } finally {
      this.vmBusy = '';
      this.paused = false;
      this.dispatch();
    }
  }

  /** Close every SSH session. Refused while policies are running or queued. */
  disconnectVm(): string {
    if (this.vmBusy) throw new BadRequestException(`already ${this.vmBusy}`);
    if (this.pending) throw new BadRequestException('policies are running or queued: stop/cancel them first, or use Reconnect');
    this.pool.disconnectAll('disconnected by user', 'Disconnected; reconnects when a batch starts');
    this.activity.log('Disconnected from the VM (all SSH sessions closed)', { level: 'warn' });
    return 'disconnected';
  }

  private async checkGcloudAuth() {
    if (this.config.get('DC_LOCAL') === 'true') return;
    const r = await spawnOnce('gcloud', ['auth', 'print-access-token', '--quiet'], 20000).catch((e: Error) => ({
      code: -1,
      stdout: '',
      stderr: e.message,
    }));
    if (r.code !== 0) {
      throw new BadRequestException(
        'gcloud login has expired. Run `gcloud auth login` in a terminal (it needs a browser), then press Reconnect again.',
      );
    }
  }

  /** Pause the queue, stop running policies (re-queued), close all sessions. Returns how many were running. */
  private async stopAllAndClose(why: string, label: string): Promise<number> {
    this.paused = true;
    const running = this.batches.flatMap((b) => b.jobs.filter((j) => j.state === 'running'));
    for (const j of running) this.stopRequests.set(j.id, { requeue: true, why: 'Interrupted by VM reconnect' });
    this.pool.disconnectAll(why, label);
    // Let the interrupted jobs unwind (they re-queue themselves) before reconnecting.
    for (let i = 0; i < 100 && this.busySessions.size; i++) await new Promise((r) => setTimeout(r, 50));
    return running.length;
  }

  /** Quick look at the VM after (re)connecting: load, memory, and leftover create-quote/psql processes. */
  private async vmHealthCheck() {
    const script = [
      `echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"`,
      `echo "memAvailMB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"`,
      `echo "curls=$(pgrep -fc 'wrapper/create-quote' || true)"`,
      `echo "psqls=$(pgrep -xc psql || true)"`,
    ].join('\n');
    try {
      const r = await this.pool.sessions[0].exec(script, 20000);
      const v = Object.fromEntries(
        r.stdout
          .split('\n')
          .map((l) => l.split('='))
          .filter((kv) => kv.length === 2),
      );
      const leftovers = Number(v.curls || 0) + Number(v.psqls || 0);
      this.activity.log(
        `VM check: load ${v.load}, ${v.memAvailMB} MB free, ${v.curls} create-quote curl and ${v.psqls} psql process(es) still running on the VM`,
        { level: leftovers ? 'warn' : 'success', session: 1 },
      );
    } catch (e) {
      this.activity.log(`VM check failed: ${(e as Error).message}`, { level: 'warn', session: 1 });
    }
  }

  /**
   * Re-queue failed (or cancelled) policies in the same batch. With no `jobIds`,
   * retries every failure that was a connection/server problem.
   */
  retry(id: string, jobIds?: string[], pgPassword?: string) {
    const b = this.find(id);
    const targets = jobIds?.length
      ? b.jobs.filter((j) => jobIds.includes(j.id) && (j.state === 'failed' || j.state === 'cancelled'))
      : b.jobs.filter((j) => j.state === 'failed' && j.failure && RETRYABLE.includes(j.failure.kind));
    if (!targets.length) throw new BadRequestException('nothing to retry');

    // A quote that was already created isn't created again: only the payload step is repeated.
    const plan = targets.map((j) => ({
      j,
      runAction: (j.action === 'all' && j.result?.quote?.success ? 'payloads' : j.action) as Action,
    }));
    if (plan.some((p) => needsPassword(p.runAction))) this.requirePassword('payloads', pgPassword);

    for (const { j, runAction } of plan) {
      if (j.failure) {
        j.history.push({ attempt: j.attempts, action: j.runAction, session: j.session, finishedAt: j.finishedAt!, failure: j.failure });
      }
      j.runAction = runAction;
      j.state = 'queued';
      j.failure = undefined;
      j.startedAt = j.finishedAt = undefined;
      j.session = undefined;
    }
    b.finishedAt = undefined;
    this.enqueue(targets, pgPassword);
    this.activity.log(`Retrying ${targets.length} polic${targets.length === 1 ? 'y' : 'ies'} in "${b.name}"`, { batch: b.id });
    this.save();
    this.dispatch();
    return this.get(b.id);
  }

  private requirePassword(action: Action, pgPassword?: string) {
    if (needsPassword(action) && !pgPassword && !this.config.get('DC_PG_PASSWORD')) {
      throw new BadRequestException('postgres password required');
    }
  }

  private enqueue(jobs: Job[], pgPassword?: string) {
    for (const j of jobs) {
      if (pgPassword) this.passwords.set(j.id, pgPassword);
      this.queue.push(j);
    }
  }

  private trim() {
    while (this.batches.length > MAX_BATCHES) {
      const i = this.batches.findIndex((b) => !b.jobs.some(isActive));
      if (i < 0) break;
      this.batches.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- execution

  /** Hand queued jobs to idle sessions; called on enqueue and whenever a job finishes. */
  private dispatch() {
    if (this.paused) return;
    const idle = this.pool.sessions
      .map((session, index) => ({ session, index }))
      .filter(({ index }) => !this.busySessions.has(index))
      // connected first, then never-opened/failed ones (which connect on demand)
      .sort((a, b) => Number(b.session.state === 'connected') - Number(a.session.state === 'connected') || a.index - b.index);

    for (const { index } of idle) {
      const next = this.queue.findIndex((j) => !this.runningPolicies.has(j.policy));
      if (next < 0) return;
      const [job] = this.queue.splice(next, 1);
      this.busySessions.add(index);
      this.runningPolicies.add(job.policy);
      void this.execute(job, index).finally(() => {
        this.busySessions.delete(index);
        this.runningPolicies.delete(job.policy);
        this.dispatch();
      });
    }
  }

  private async execute(job: Job, index: number) {
    const session = this.pool.sessions[index];
    const batch = this.batches.find((b) => b.id === job.batchId);
    job.state = 'running';
    job.attempts++;
    job.session = session.id;
    job.startedAt = new Date().toISOString();
    const password = this.passwords.get(job.id);
    this.passwords.delete(job.id);
    const ctx = { session: session.id, policy: job.policy, batch: job.batchId };
    const step = (label: string, phase: Phase) => this.activity.set(session.id, phase, label, job.policy, job.runAction);

    // Updated from the progress callback; tells timeouts/stops which step they interrupted.
    let step_ = 'connect' as 'connect' | 'quote' | 'payload';
    const connected = session.state === 'connected';
    step(connected ? 'Starting job' : 'Connecting before job…', connected ? 'starting' : 'connecting');
    const attemptNote = job.attempts > 1 ? `, attempt ${job.attempts}` : '';
    this.activity.log(`Job started (${job.runAction}${attemptNote})`, ctx);
    this.save();

    try {
      const { result, failure } = await this.dc.run(job.policy, job.runAction, session, password, (msg, opts = {}) => {
        if (opts.phase === 'quote') step_ = 'quote';
        if (opts.phase === 'payload' || opts.phase === 'saving') step_ = 'payload';
        if (opts.phase) step(msg, opts.phase);
        this.activity.log(msg, { ...ctx, level: opts.level });
      });
      // Payload-only retry after a created quote: keep the quote from the earlier attempt.
      if (job.runAction !== job.action && job.result?.quote) result.quote = job.result.quote;
      job.result = result;
      job.failure = failure;
      job.state = failure ? 'failed' : 'succeeded';
    } catch (e) {
      job.state = 'failed';
      job.failure = this.classifyThrown(e as Error, job, step_);
      if (!this.stopRequests.has(job.id)) {
        this.logger.warn(`[${job.policy}] session #${session.id}: ${job.failure.reason}`);
        this.activity.log(`Job failed: ${job.failure.reason}`, { ...ctx, level: 'error' });
      }
    }

    const stopReq = this.stopRequests.get(job.id);
    this.stopRequests.delete(job.id);
    if (stopReq && job.state === 'failed') {
      const { requeue, why } = stopReq;
      const stopped: Failure = {
        kind: 'stopped',
        step: step_,
        mayHaveRun: step_ === 'quote' && job.runAction !== 'payloads',
        reason: `${why} during ${step_ === 'connect' ? 'connect' : step_ === 'quote' ? 'create-quote' : 'the payload query'}`,
      };
      if (requeue) {
        job.history.push({ attempt: job.attempts, action: job.runAction, session: session.id, finishedAt: new Date().toISOString(), failure: stopped });
        job.state = 'queued';
        job.failure = undefined;
        job.startedAt = job.session = undefined;
        if (password) this.passwords.set(job.id, password);
        this.queue.push(job);
        this.activity.log(`${why}; put back in the queue`, { ...ctx, level: 'warn' });
      } else {
        job.state = 'cancelled';
        job.failure = stopped;
        job.finishedAt = new Date().toISOString();
        this.activity.log('Stopped by user', { ...ctx, level: 'warn' });
      }
      if (batch) this.finishBatchIfDone(batch);
      this.save();
      return;
    }

    job.finishedAt = new Date().toISOString();
    const secs = ((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1);
    if (job.state === 'succeeded') this.activity.log(`Succeeded in ${secs}s`, { ...ctx, level: 'success' });
    else this.activity.log(`Failed after ${secs}s (${job.failure!.kind})`, { ...ctx, level: 'error' });
    // A failed connect/timeout already set 'disconnected'; otherwise the session is free again.
    if (session.state === 'connected') this.activity.set(session.id, 'idle', 'Idle, waiting for jobs');

    if (batch) this.finishBatchIfDone(batch);
    this.save();
  }

  /** Errors thrown out of a run are session/system problems (or a missing password). */
  private classifyThrown(e: Error, job: Job, step: 'connect' | 'quote' | 'payload'): Failure {
    if (e instanceof BadRequestException) {
      return { kind: 'input', step: 'connect', mayHaveRun: false, reason: e.message };
    }
    if (e instanceof SessionLostError) {
      const mayHaveRun = e.started && step === 'quote';
      if (e.endCause === 'timeout') {
        // The remote command never answered: the API (or Postgres) is slow/hung, not our connection.
        return step === 'payload'
          ? { kind: 'connection', step, mayHaveRun: false, reason: `Postgres query didn't respond: ${e.message}` }
          : { kind: 'server', step, mayHaveRun, reason: `create-quote didn't respond: ${e.message} (gave up waiting)` };
      }
      return { kind: 'connection', step, mayHaveRun, reason: `SSH session broke during the job: ${e.message}` };
    }
    return { kind: 'connection', step: 'connect', mayHaveRun: false, reason: `Could not open an SSH session: ${e.message}` };
  }

  private finishBatchIfDone(b: Batch) {
    if (b.jobs.some(isActive) || b.finishedAt) return;
    b.finishedAt = new Date().toISOString();
    const s = this.summarize(b);
    const parts = [`${s.succeeded} succeeded`, `${s.failed} failed`];
    if (s.retryable) parts.push(`${s.retryable} worth retrying`);
    if (s.cancelled) parts.push(`${s.cancelled} cancelled`);
    this.activity.log(`Batch "${b.name}" finished: ${parts.join(', ')}`, {
      level: s.failed ? 'warn' : 'success',
      batch: b.id,
    });
  }
}
