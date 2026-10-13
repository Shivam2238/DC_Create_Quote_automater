import { Injectable } from '@nestjs/common';

export type Phase = 'disconnected' | 'connecting' | 'idle' | 'starting' | 'quote' | 'payload' | 'saving';
export type Level = 'info' | 'success' | 'warn' | 'error';

export interface SessionActivity {
  phase: Phase;
  label: string;
  policy?: string;
  /** Action of the job being run, so the UI can draw its step tracker. */
  action?: string;
  since: string;
}

export interface ActivityEvent {
  seq: number;
  at: string;
  level: Level;
  session?: number;
  policy?: string;
  batch?: string;
  msg: string;
}

const MAX_EVENTS = 500;

/**
 * Live view of what every SSH session is doing right now, plus a rolling event
 * log. Written to by the sessions (connect/disconnect, gcloud output) and by the
 * queue (job steps); read by the UI through GET /api/jobs.
 */
@Injectable()
export class ActivityService {
  private readonly current = new Map<number, SessionActivity>();
  private readonly events: ActivityEvent[] = [];
  private seq = 0;

  set(session: number, phase: Phase, label: string, policy?: string, action?: string) {
    this.current.set(session, { phase, label, policy, action, since: new Date().toISOString() });
  }

  get(session: number): SessionActivity {
    return this.current.get(session) ?? { phase: 'disconnected', label: 'Not opened yet', since: new Date().toISOString() };
  }

  log(msg: string, opts: { level?: Level; session?: number; policy?: string; batch?: string } = {}) {
    this.events.push({ ...opts, seq: ++this.seq, at: new Date().toISOString(), level: opts.level ?? 'info', msg });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Events newer than `since` (sequence number), capped to the most recent `limit`. */
  recent(since = 0, limit = 300): ActivityEvent[] {
    return this.events.filter((e) => e.seq > since).slice(-limit);
  }
}
