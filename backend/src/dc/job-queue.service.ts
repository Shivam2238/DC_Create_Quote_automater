import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Action, DcService, RunResult } from './dc.service';
import { ActivityService, Phase } from './activity.service';
import { SshPoolService } from './ssh-pool.service';

export type JobState = 'queued' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  batchId: string;
  policy: string;
  action: Action;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Which pooled SSH session ran it. */
  session?: number;
  result?: RunResult;
  error?: string;
}

const MAX_HISTORY = 500;

/**
 * FIFO queue in front of the SSH pool: one worker per session, so up to
 * DC_SESSIONS policies run in parallel. Idle sessions that are already connected
 * get work first, so extra sessions only open when the queue is deep enough.
 * The same policy is never run on two sessions at once.
 * Jobs live in memory only; the Postgres password is held just until the job runs.
 */
@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly jobs: Job[] = [];
  private readonly passwords = new Map<string, string>();
  private queue: Job[] = [];
  private readonly busySessions = new Set<number>(); // pool indexes with a job in flight
  private readonly runningPolicies = new Set<string>();

  constructor(
    private readonly dc: DcService,
    private readonly pool: SshPoolService,
    private readonly config: ConfigService,
    private readonly activity: ActivityService,
  ) {}

  enqueue(policies: string[], action: Action, pgPassword?: string): Job[] {
    const list = [...new Set((policies ?? []).map((p) => String(p).trim()).filter(Boolean))];
    if (!list.length) throw new BadRequestException('no policy numbers given');
    const bad = list.filter((p) => !/^\d+$/.test(p));
    if (bad.length) throw new BadRequestException(`policy number must be digits only: ${bad.join(', ')}`);
    if (!['quote', 'payloads', 'all'].includes(action)) throw new BadRequestException('invalid action');
    if (action !== 'quote' && !pgPassword && !this.config.get('DC_PG_PASSWORD')) {
      throw new BadRequestException('postgres password required');
    }

    const batchId = randomUUID();
    const created = list.map<Job>((policy) => ({
      id: randomUUID(),
      batchId,
      policy,
      action,
      state: 'queued',
      createdAt: new Date().toISOString(),
    }));
    for (const job of created) {
      if (pgPassword) this.passwords.set(job.id, pgPassword);
      this.jobs.push(job);
      this.queue.push(job);
    }
    this.trimHistory();
    this.activity.log(`Queued ${created.length} polic${created.length === 1 ? 'y' : 'ies'} (${action})`);
    this.dispatch();
    return created;
  }

  list(): Job[] {
    return this.jobs;
  }

  /** Remove queued (not yet started) jobs. */
  cancelQueued(): number {
    const n = this.queue.length;
    for (const job of this.queue) {
      job.state = 'error';
      job.error = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.passwords.delete(job.id);
    }
    this.queue = [];
    if (n) this.activity.log(`Cancelled ${n} queued job${n === 1 ? '' : 's'}`, { level: 'warn' });
    return n;
  }

  /** Forget finished jobs. */
  clearFinished(): void {
    const keep = this.jobs.filter((j) => j.state === 'queued' || j.state === 'running');
    this.jobs.splice(0, this.jobs.length, ...keep);
  }

  get pending(): number {
    return this.queue.length + this.busySessions.size;
  }

  /** Hand queued jobs to idle sessions; called on enqueue and whenever a job finishes. */
  private dispatch() {
    const idle = this.pool.sessions
      .map((session, index) => ({ session, index }))
      .filter(({ index }) => !this.busySessions.has(index))
      // connected first, then never-opened/failed ones (which connect on demand)
      .sort((a, b) => Number(b.session.state === 'connected') - Number(a.session.state === 'connected') || a.index - b.index);

    for (const { session, index } of idle) {
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
    job.state = 'running';
    job.session = session.id;
    job.startedAt = new Date().toISOString();
    const password = this.passwords.get(job.id);
    this.passwords.delete(job.id);
    const ctx = { session: session.id, policy: job.policy };
    const step = (label: string, phase: Phase = 'starting') => this.activity.set(session.id, phase, label, job.policy);

    step(session.state === 'connected' ? 'Starting job' : 'Connecting before job…', session.state === 'connected' ? 'starting' : 'connecting');
    this.activity.log(`Job started (${job.action})`, ctx);
    try {
      job.result = await this.dc.run(job.policy, job.action, session, password, (msg, opts = {}) => {
        if (opts.phase) step(msg, opts.phase);
        this.activity.log(msg, { ...ctx, level: opts.level });
      });
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = (e as Error).message;
      this.logger.warn(`[${job.policy}] session #${session.id}: ${job.error}`);
      this.activity.log(`Job failed: ${job.error}`, { ...ctx, level: 'error' });
    }
    job.finishedAt = new Date().toISOString();
    const secs = ((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1);
    if (job.state === 'done') this.activity.log(`Job finished in ${secs}s`, { ...ctx, level: 'success' });
    // A failed connect/timeout already set 'disconnected'; otherwise the session is free again.
    if (session.state === 'connected') this.activity.set(session.id, 'idle', 'Idle, waiting for jobs');
  }

  private trimHistory() {
    const excess = this.jobs.length - MAX_HISTORY;
    if (excess <= 0) return;
    // Drop the oldest finished jobs first.
    let dropped = 0;
    for (let i = 0; i < this.jobs.length && dropped < excess; ) {
      if (this.jobs[i].state === 'done' || this.jobs[i].state === 'error') {
        this.jobs.splice(i, 1);
        dropped++;
      } else i++;
    }
  }
}
