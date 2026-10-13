export type Action = 'quote' | 'payloads' | 'all'
export type PayloadKind = 'request' | 'response'

export interface QuoteResult {
  success: boolean
  quoteNumber?: string
  premium?: string
  isPremiumMatched?: string
  cohortType?: string
  raw: unknown
}

export interface PayloadResult {
  kind: PayloadKind
  status: 'saved' | 'null' | 'not-json'
  file?: string
  content?: unknown
}

export interface RunResult {
  policy: string
  quote?: QuoteResult
  payloads?: PayloadResult[]
  message?: string
}

export type JobState = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  batchId: string
  policy: string
  action: Action
  state: JobState
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** Which pooled SSH session ran it. */
  session?: number
  result?: RunResult
  error?: string
}

export type Phase = 'disconnected' | 'connecting' | 'idle' | 'starting' | 'quote' | 'payload' | 'saving'
export type Level = 'info' | 'success' | 'warn' | 'error'

export interface SessionActivity {
  phase: Phase
  label: string
  policy?: string
  since: string
}

export interface ActivityEvent {
  seq: number
  at: string
  level: Level
  session?: number
  policy?: string
  msg: string
}

export interface SessionInfo {
  id: number
  activity: SessionActivity
  state: 'disconnected' | 'connecting' | 'connected'
  lastError: string
  connectedAt?: string
}

export interface JobsSnapshot {
  sessions: SessionInfo[]
  pending: number
  jobs: Job[]
  events: ActivityEvent[]
  lastSeq: number
}

export interface Status {
  gcloud: { ok: boolean; account: string; detail: string }
  vm: { name: string; zone: string; project: string; local: boolean }
  sessions: SessionInfo[]
  pgPasswordConfigured: boolean
  outDir: string
}

export interface SavedFile {
  name: string
  size: number
  modified: string
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`)
  return body as T
}

export const api = {
  status: () => fetch('/api/status').then((r) => json<Status>(r)),
  files: () => fetch('/api/files').then((r) => json<SavedFile[]>(r)),
  fileUrl: (name: string) => `/api/files/${encodeURIComponent(name)}`,
  jobs: (since = 0) => fetch(`/api/jobs?since=${since}`).then((r) => json<JobsSnapshot>(r)),
  enqueue: (policies: string[], action: Action, pgPassword?: string) =>
    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies, action, pgPassword: pgPassword || undefined }),
    }).then((r) => json<Job[]>(r)),
  cancelQueued: () => fetch('/api/jobs/cancel', { method: 'POST' }).then((r) => json<{ cancelled: number }>(r)),
  clearFinished: () => fetch('/api/jobs', { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  reconnect: () => fetch('/api/session/reconnect', { method: 'POST' }).then((r) => json<SessionInfo[]>(r)),
}
