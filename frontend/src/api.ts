export type Action = 'quote' | 'payloads' | 'all'

/** Health (2856…) and Motor (2302…) run separately: each batch belongs to one product. */
export type Product = 'health' | 'motor'
export const PRODUCTS: Product[] = ['health', 'motor']
export const PRODUCT_INFO: Record<Product, { label: string; prefix: string }> = {
  health: { label: 'Health', prefix: '2856' },
  motor: { label: 'Motor', prefix: '2302' },
}
export const productOf = (policy: string): Product | undefined =>
  PRODUCTS.find((p) => policy.startsWith(PRODUCT_INFO[p].prefix))

/** Health: request/response. Motor: dc_request/dc_response/blaze_request/blaze_response. */
export type PayloadKind = string
export const PAYLOAD_LABEL: Record<string, string> = {
  request: 'Request',
  response: 'Response',
  dc_request: 'DC req',
  dc_response: 'DC resp',
  blaze_request: 'Blaze req',
  blaze_response: 'Blaze resp',
}

export interface QuoteResult {
  success: boolean
  quoteNumber?: string
  /** Gross premium (Motor: PurePremium + TaxesSurcharges). */
  premium?: string
  purePremium?: string
  taxes?: string
  discount?: string
  quoteId?: string
  imdCode?: string
  cohortType?: string
  quoteGeneratedDate?: string
  /** Health only: the wrapper's own premium comparison. */
  isPremiumMatched?: string
  httpStatus?: number
  /** Wrapper response, inline when small… */
  raw?: unknown
  /** …or saved to this file (Motor's full DuckCreek session). */
  rawFile?: string
}

export interface PayloadResult {
  kind: PayloadKind
  status: 'saved' | 'null' | 'not-json'
  file?: string
  size?: number
}

export interface RunResult {
  policy: string
  quote?: QuoteResult
  payloads?: PayloadResult[]
  /** Error text found in DuckCreek's external_response when create-quote failed. */
  externalError?: string
}

export interface DbLogs {
  state: 'queued' | 'running' | 'done' | 'error'
  requestedAt: string
  fetchedAt?: string
  payloads?: PayloadResult[]
  summary?: string
  error?: string
}

/**
 * connection: our side (SSH, network, timeout), retry recommended
 * server:     create-quote service/gateway error (5xx), retry may work
 * api:        the API/data said no; retrying won't help
 * input:      something we supplied is wrong (e.g. Postgres password)
 */
export type FailureKind = 'connection' | 'server' | 'api' | 'input' | 'stopped'
export const RETRYABLE: FailureKind[] = ['connection', 'server']

export interface Failure {
  kind: FailureKind
  reason: string
  step: 'connect' | 'quote' | 'payload'
  mayHaveRun: boolean
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface Attempt {
  attempt: number
  action: Action
  session?: number
  finishedAt: string
  failure: Failure
}

export interface Job {
  id: string
  batchId: string
  product: Product
  policy: string
  action: Action
  runAction: Action
  state: JobState
  attempts: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  session?: number
  result?: RunResult
  failure?: Failure
  history: Attempt[]
  autoRetries?: number
  /** Waiting for an automatic retry that starts at this time. */
  retryAt?: string
  dbLogs?: DbLogs
}

export interface Settings {
  concurrency: number
  autoRetries: number
  maxSessions: number
  maxAutoRetries: number
}

export type BatchStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface BatchSummary {
  id: string
  name: string
  product: Product
  action: Action
  createdAt: string
  finishedAt?: string
  status: BatchStatus
  total: number
  succeeded: number
  failed: number
  retryable: number
  running: number
  queued: number
  cancelled: number
}

export interface BatchDetail {
  summary: BatchSummary
  jobs: Job[]
}

export type Phase = 'disconnected' | 'connecting' | 'idle' | 'starting' | 'quote' | 'payload' | 'saving'
export type Level = 'info' | 'success' | 'warn' | 'error'

export interface SessionActivity {
  phase: Phase
  label: string
  policy?: string
  action?: Action
  since: string
}

export interface SessionInfo {
  id: number
  state: 'disconnected' | 'connecting' | 'connected'
  lastError: string
  connectedAt?: string
  activity: SessionActivity
}

export interface ActivityEvent {
  seq: number
  at: string
  level: Level
  session?: number
  policy?: string
  batch?: string
  msg: string
}

export interface AppState {
  sessions: SessionInfo[]
  pending: number
  vmBusy: '' | 'reconnecting' | 'disconnecting'
  settings: Settings
  batches: BatchSummary[]
  selected: BatchDetail | null
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

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`)
  return body as T
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

export const api = {
  status: () => fetch('/api/status').then((r) => json<Status>(r)),
  state: (since: number, batch?: string) =>
    fetch(`/api/state?since=${since}${batch ? `&batch=${encodeURIComponent(batch)}` : ''}`).then((r) => json<AppState>(r)),
  createBatch: (product: Product, policies: string[], action: Action, name?: string, pgPassword?: string) =>
    send('POST', '/api/batches', { product, policies, action, name: name || undefined, pgPassword: pgPassword || undefined }).then((r) =>
      json<BatchDetail>(r),
    ),
  rename: (id: string, name: string) => send('PATCH', `/api/batches/${id}`, { name }).then((r) => json<BatchSummary>(r)),
  remove: (id: string) => send('DELETE', `/api/batches/${id}`).then((r) => json<{ ok: boolean }>(r)),
  cancel: (id: string) => send('POST', `/api/batches/${id}/cancel`).then((r) => json<{ cancelled: number }>(r)),
  retry: (id: string, jobIds?: string[], pgPassword?: string) =>
    send('POST', `/api/batches/${id}/retry`, { jobIds, pgPassword: pgPassword || undefined }).then((r) => json<BatchDetail>(r)),
  stop: (id: string, jobId: string, requeue: boolean) =>
    send('POST', `/api/batches/${id}/jobs/${jobId}/stop`, { requeue }).then((r) => json<BatchDetail>(r)),
  fetchDbLogs: (id: string, jobIds?: string[], pgPassword?: string) =>
    send('POST', `/api/batches/${id}/db-logs`, { jobIds, pgPassword: pgPassword || undefined }).then((r) => json<BatchDetail>(r)),
  updateSettings: (patch: Partial<Pick<Settings, 'concurrency' | 'autoRetries'>>) =>
    send('PATCH', '/api/settings', patch).then((r) => json<Settings>(r)),
  vmReconnect: () => send('POST', '/api/vm/reconnect').then((r) => json<{ result: string; sessions: SessionInfo[] }>(r)),
  vmDisconnect: () => send('POST', '/api/vm/disconnect').then((r) => json<{ result: string; sessions: SessionInfo[] }>(r)),
  reconnect: () => send('POST', '/api/session/reconnect').then((r) => json<SessionInfo[]>(r)),
  fileUrl: (name: string) => `/api/files/${encodeURIComponent(name)}`,
  fileText: (name: string) =>
    fetch(`/api/files/${encodeURIComponent(name)}`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    }),
}
