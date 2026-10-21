import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  PAYLOAD_LABEL,
  PRODUCT_INFO,
  productOf,
  RETRYABLE,
  type Action,
  type BatchDetail,
  type BatchSummary,
  type DbLogs,
  type FailureKind,
  type Job,
  type PayloadResult,
  type Product,
  type SessionInfo,
} from './api'
import { copy, downloadText, fmtDuration, fmtTime, useNow, type Viewing } from './ui'

const ACTIONS: { value: Action; label: string }[] = [
  { value: 'quote', label: 'Create quote' },
  { value: 'payloads', label: 'Fetch payloads' },
  { value: 'all', label: 'Both' },
]
const ACTION_LABEL: Record<Action, string> = { quote: 'Create quote', payloads: 'Fetch payloads', all: 'Quote + payloads' }

export const KIND_LABEL: Record<FailureKind, string> = {
  connection: 'Connection',
  server: 'Server error',
  api: 'API rejected',
  input: 'Input',
  stopped: 'Stopped',
}

function parsePolicies(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))]
}

function previewName(product: Product, d: Date): string {
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  return `${PRODUCT_INFO[product].label} · ${date} · ${d.toLocaleTimeString('en-GB', { hour12: false })}`
}

// ---------------------------------------------------------------- composer

export function Composer(props: {
  product: Product
  /** Switch the whole page to the other product (offered when pasted numbers belong to it). */
  onSwitchProduct: (p: Product) => void
  pgPassword: string
  setPgPassword: (v: string) => void
  pgConfigured: boolean
  onCreated: (b: BatchDetail) => void
}) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [action, setAction] = useState<Action>('quote')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const now = useNow(1000)

  const { label, prefix } = PRODUCT_INFO[props.product]
  const policies = useMemo(() => parsePolicies(text), [text])
  const invalid = policies.filter((p) => !/^\d+$/.test(p))
  // Valid digits but the wrong product (e.g. a Motor number in a Health batch).
  const wrongProduct = policies.filter((p) => /^\d+$/.test(p) && productOf(p) !== props.product)
  const otherProduct = wrongProduct.length ? productOf(wrongProduct[0]) : undefined
  const allOther = !!otherProduct && wrongProduct.length === policies.length && wrongProduct.every((p) => productOf(p) === otherProduct)
  const needsPw = action !== 'quote' && !props.pgConfigured
  const canStart =
    !busy && policies.length > 0 && !invalid.length && !wrongProduct.length && (!needsPw || !!props.pgPassword)

  async function start() {
    if (!canStart) return
    setBusy(true)
    setError('')
    try {
      const b = await api.createBatch(props.product, policies, action, name.trim(), props.pgPassword)
      setText('')
      setName('')
      props.onCreated(b)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`card composer product-${props.product}`}>
      <h2>
        New {label} batch <span className="muted small">policies start with {prefix}</span>
      </h2>
      <label className="field">
        <span>Name <span className="muted small">(optional)</span></span>
        <input value={name} maxLength={100} placeholder={previewName(props.product, new Date(now))} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Policy numbers</span>
        <textarea
          rows={5}
          placeholder={`${prefix}000000000000000\nOne per line, or separated by commas/spaces`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && start()}
        />
        <small className={invalid.length || wrongProduct.length ? 'err' : 'muted'}>
          {invalid.length
            ? `Not a valid policy number: ${invalid.join(', ')}`
            : wrongProduct.length
              ? `Not ${label} (${label} starts with ${prefix}): ${wrongProduct.slice(0, 5).join(', ')}${wrongProduct.length > 5 ? ` +${wrongProduct.length - 5} more` : ''}`
              : `${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} · Ctrl+Enter to start`}
        </small>
        {allOther && otherProduct && (
          <button type="button" className="ghost tiny switch-hint" onClick={() => props.onSwitchProduct(otherProduct)}>
            These are {PRODUCT_INFO[otherProduct].label} policies → switch to {PRODUCT_INFO[otherProduct].label}
          </button>
        )}
      </label>
      <div className="segmented full" role="radiogroup" aria-label="Action">
        {ACTIONS.map((a) => (
          <button
            key={a.value}
            role="radio"
            aria-checked={action === a.value}
            className={action === a.value ? 'on' : ''}
            onClick={() => setAction(a.value)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {action !== 'quote' && (
        <input
          type="password"
          autoComplete="off"
          placeholder={props.pgConfigured ? 'Postgres password (using server .env)' : 'Postgres password'}
          value={props.pgPassword}
          onChange={(e) => props.setPgPassword(e.target.value)}
        />
      )}
      <button className="primary" disabled={!canStart} onClick={start}>
        {busy ? 'Starting…' : `Start ${label} batch${policies.length ? ` (${policies.length})` : ''}`}
      </button>
      {error && <small className="err">{error}</small>}
    </section>
  )
}

// ---------------------------------------------------------------- batch list

export function statusText(b: BatchSummary): string {
  const done = b.succeeded + b.failed + b.cancelled
  if (b.status === 'running') return `Running · ${done}/${b.total}`
  if (b.status === 'succeeded') return b.total === 1 ? 'Succeeded' : `All ${b.total} succeeded`
  if (b.status === 'failed') return `${b.failed} failed`
  return 'Cancelled'
}

export function ProgressBar({ b }: { b: BatchSummary }) {
  const seg = (n: number, cls: string) =>
    n > 0 && <span className={`seg ${cls}`} style={{ flexGrow: n }} title={`${n} ${cls}`} />
  return (
    <div className="progress" aria-hidden>
      {seg(b.succeeded, 'succeeded')}
      {seg(b.failed, 'failed')}
      {seg(b.cancelled, 'cancelled')}
      {seg(b.running, 'running')}
      {seg(b.queued, 'queued')}
    </div>
  )
}

export function BatchList(props: {
  product: Product
  batches: BatchSummary[]
  selectedId?: string
  onSelect: (id: string) => void
}) {
  return (
    <section className="card batch-list">
      <h2>
        {PRODUCT_INFO[props.product].label} batches <span className="muted small">{props.batches.length}</span>
      </h2>
      {props.batches.length === 0 ? (
        <p className="muted small">No {PRODUCT_INFO[props.product].label} batches yet. Start one above.</p>
      ) : (
        <ul>
          {props.batches.map((b) => (
            <li key={b.id}>
              <button
                className={`batch-item ${b.id === props.selectedId ? 'selected' : ''}`}
                onClick={() => props.onSelect(b.id)}
                aria-current={b.id === props.selectedId}
              >
                <div className="batch-item-top">
                  <span className="batch-name">{b.name}</span>
                  <span className={`status-chip ${b.status}`}>{statusText(b)}</span>
                </div>
                <ProgressBar b={b} />
                <div className="muted small">
                  {ACTION_LABEL[b.action]} · {b.total} polic{b.total === 1 ? 'y' : 'ies'} · {fmtTime(b.createdAt)}
                  {b.retryable > 0 && <span className="retry-hint"> · {b.retryable} to retry</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- batch detail

type Filter = 'all' | 'succeeded' | 'failed' | 'active' | 'cancelled'

const matches = (j: Job, f: Filter) =>
  f === 'all' ||
  (f === 'active' ? j.state === 'queued' || j.state === 'running' : j.state === f)

function jobDuration(j: Job, now: number): number | undefined {
  if (!j.startedAt) return undefined
  return (j.finishedAt ? Date.parse(j.finishedAt) : now) - Date.parse(j.startedAt)
}

type ReportValue = string | number | undefined

interface ReportColumn {
  header: string
  width: number
  /** Always a text cell (digit-only values like policy numbers must never become numbers). */
  text?: boolean
  get: (j: Job) => ReportValue
}

const num = (v?: string): ReportValue => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : v)
const payloadCell = (kind: string) => (j: Job) => {
  const p = j.result?.payloads?.find((x) => x.kind === kind)
  return p?.file ?? p?.status
}

/** Report columns: shared ones plus the product's own quote/payload fields. */
function reportColumns(product: Product): ReportColumn[] {
  const head: ReportColumn[] = [
    { header: 'policy_number', width: 22, text: true, get: (j) => j.policy },
    { header: 'status', width: 11, get: (j) => j.state },
    { header: 'failure_type', width: 13, get: (j) => (j.failure ? KIND_LABEL[j.failure.kind] : undefined) },
    { header: 'failure_reason', width: 60, get: (j) => j.failure?.reason },
    { header: 'external_error', width: 50, get: (j) => j.result?.externalError ?? j.dbLogs?.summary },
    { header: 'may_have_created_quote', width: 12, get: (j) => (j.failure ? (j.failure.mayHaveRun ? 'yes' : 'no') : undefined) },
    { header: 'quote_number', width: 20, text: true, get: (j) => j.result?.quote?.quoteNumber },
    { header: 'premium', width: 10, get: (j) => num(j.result?.quote?.premium) },
  ]
  const health: ReportColumn[] = [
    {
      header: 'premium_matched',
      width: 10,
      get: (j) => {
        const m = j.result?.quote?.isPremiumMatched
        return m === undefined ? undefined : m === '1' ? 'yes' : 'no'
      },
    },
    { header: 'cohort', width: 8, get: (j) => j.result?.quote?.cohortType },
    { header: 'http_status', width: 8, get: (j) => j.result?.quote?.httpStatus },
    { header: 'request_payload', width: 34, get: payloadCell('request') },
    { header: 'response_payload', width: 34, get: payloadCell('response') },
  ]
  const motor: ReportColumn[] = [
    { header: 'pure_premium', width: 10, get: (j) => num(j.result?.quote?.purePremium) },
    { header: 'taxes', width: 9, get: (j) => num(j.result?.quote?.taxes) },
    { header: 'discount', width: 9, get: (j) => num(j.result?.quote?.discount) },
    { header: 'quote_id', width: 10, text: true, get: (j) => j.result?.quote?.quoteId },
    { header: 'imd_code', width: 14, text: true, get: (j) => j.result?.quote?.imdCode },
    { header: 'cohort', width: 8, get: (j) => j.result?.quote?.cohortType },
    { header: 'http_status', width: 8, get: (j) => j.result?.quote?.httpStatus },
    { header: 'dc_request', width: 32, get: payloadCell('dc_request') },
    { header: 'dc_response', width: 32, get: payloadCell('dc_response') },
    { header: 'blaze_request', width: 32, get: payloadCell('blaze_request') },
    { header: 'blaze_response', width: 32, get: payloadCell('blaze_response') },
  ]
  const tail: ReportColumn[] = [
    { header: 'attempts', width: 8, get: (j) => j.attempts },
    { header: 'session', width: 8, get: (j) => j.session },
    { header: 'started_at', width: 24, get: (j) => j.startedAt },
    { header: 'finished_at', width: 24, get: (j) => j.finishedAt },
    {
      header: 'duration_s',
      width: 10,
      get: (j) =>
        j.startedAt && j.finishedAt ? Number(((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000).toFixed(1)) : undefined,
    },
  ]
  return [...head, ...(product === 'motor' ? motor : health), ...tail]
}

/** Plain CSV for scripts/tools. (Excel shows 19-digit numbers as 2.8E+18: use the Excel download there.) */
function csvReport(detail: BatchDetail): string {
  const cols = reportColumns(detail.summary.product)
  const esc = (v: ReportValue) => {
    const s = v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [cols.map((c) => c.header), ...detail.jobs.map((j) => cols.map((c) => esc(c.get(j))))]
  return lines.map((r) => r.join(',')).join('\n') + '\n'
}

/** .xlsx with policy/quote numbers stored as text cells, so they show exactly. Library is loaded on demand. */
async function downloadExcelReport(detail: BatchDetail, fileName: string) {
  const { default: writeExcelFile } = await import('write-excel-file/browser')
  const cols = reportColumns(detail.summary.product)
  const header = cols.map((c) => ({ value: c.header, type: String, fontWeight: 'bold' as const }))
  const rows = detail.jobs.map((j) =>
    cols.map((c) => {
      const v = c.get(j)
      if (v === undefined) return null
      return c.text || typeof v === 'string' ? { value: String(v), type: String } : { value: v, type: Number }
    }),
  )
  await writeExcelFile([header, ...rows], {
    sheet: `${PRODUCT_INFO[detail.summary.product].label} report`,
    columns: cols.map((c) => ({ width: c.width })),
    stickyRowsCount: 1,
  }).toFile(fileName)
}

export function BatchDetailView(props: {
  detail: BatchDetail
  sessions: SessionInfo[]
  pgPassword: string
  setPgPassword: (v: string) => void
  pgConfigured: boolean
  onView: (v: Viewing) => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const { detail, sessions } = props
  const b = detail.summary
  const now = useNow(500)
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(b.name)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  // New batch selected: reset local UI state.
  useEffect(() => {
    setFilter('all')
    setEditing(false)
    setError('')
  }, [b.id])
  useEffect(() => {
    if (editing) nameInput.current?.select()
  }, [editing])

  const jobs = detail.jobs
  const retryable = jobs.filter((j) => j.state === 'failed' && j.failure && RETRYABLE.includes(j.failure.kind))
  const notRetryable = jobs.filter((j) => j.state === 'failed' && j.failure && !RETRYABLE.includes(j.failure.kind))
  const riskyRetry = retryable.filter((j) => j.failure!.mayHaveRun && !j.result?.quote?.success)
  const payloadOnly = retryable.filter((j) => j.action === 'all' && j.result?.quote?.success)
  // Any retry of a job with a payload step (incl. payload-only re-fetches) needs the password.
  const retryNeedsPw = (list: Job[]) => !props.pgConfigured && list.some((j) => j.action !== 'quote')
  const shown = jobs.filter((j) => matches(j, filter))
  const quoteNumbers = jobs.map((j) => j.result?.quote?.quoteNumber).filter(Boolean) as string[]
  const failedPolicies = jobs.filter((j) => j.state === 'failed').map((j) => j.policy)
  const elapsed = (b.finishedAt ? Date.parse(b.finishedAt) : now) - Date.parse(b.createdAt)
  const fileBase = b.name.replace(/[^\w.-]+/g, '_')

  async function act(fn: () => Promise<unknown>) {
    setWorking(true)
    setError('')
    try {
      await fn()
      props.onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }

  const retry = (ids?: string[]) => act(() => api.retry(b.id, ids, props.pgPassword))

  async function saveName() {
    const name = draft.trim()
    if (!name || name === b.name) return setEditing(false)
    await act(() => api.rename(b.id, name))
    setEditing(false)
  }

  const tiles: { f: Filter; label: string; n: number; cls: string }[] = [
    { f: 'all', label: 'Total', n: b.total, cls: '' },
    { f: 'succeeded', label: 'Succeeded', n: b.succeeded, cls: 'good' },
    { f: 'failed', label: 'Failed', n: b.failed, cls: b.failed ? 'bad' : '' },
    { f: 'active', label: 'In progress', n: b.running + b.queued, cls: b.running + b.queued ? 'running' : '' },
  ]
  if (b.cancelled) tiles.push({ f: 'cancelled', label: 'Cancelled', n: b.cancelled, cls: 'muted-tile' })

  return (
    <section className="card detail">
      <div className="detail-head">
        <div className="detail-title">
          {editing ? (
            <form
              className="rename"
              onSubmit={(e) => {
                e.preventDefault()
                void saveName()
              }}
            >
              <input
                ref={nameInput}
                value={draft}
                maxLength={100}
                aria-label="Batch name"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
              />
              <button className="primary tiny-primary" type="submit" disabled={working}>Save</button>
              <button className="ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          ) : (
            <>
              <h2 className="batch-title">{b.name}</h2>
              <button
                className="ghost tiny"
                onClick={() => {
                  setDraft(b.name)
                  setEditing(true)
                }}
                title="Rename batch"
              >
                ✎ Rename
              </button>
            </>
          )}
        </div>
        <div className="muted small">
          {ACTION_LABEL[b.action]} · started {new Date(b.createdAt).toLocaleString()} ·{' '}
          {b.status === 'running' ? `running for ${fmtDuration(elapsed)}` : `took ${fmtDuration(elapsed)}`}
        </div>
      </div>

      {b.status !== 'running' && (
        <div className={`report-banner ${b.failed ? 'warn' : b.status === 'cancelled' ? 'muted-banner' : 'good'}`}>
          <strong>
            {b.status === 'succeeded' && `All ${b.total} polic${b.total === 1 ? 'y' : 'ies'} succeeded.`}
            {b.status === 'failed' && `Finished: ${b.succeeded} succeeded, ${b.failed} failed.`}
            {b.status === 'cancelled' && `Cancelled: ${b.succeeded} succeeded before cancelling, ${b.cancelled} not run.`}
          </strong>{' '}
          {b.failed > 0 &&
            (b.retryable === b.failed
              ? 'All failures look like connection/server problems. See below to retry.'
              : b.retryable
                ? `${b.retryable} look like connection/server problems; ${b.failed - b.retryable} were rejected by the API or had bad input.`
                : 'The API rejected them or the input was wrong, so retrying will not help until that is fixed.')}
        </div>
      )}

      <div className="tiles" role="tablist" aria-label="Filter policies">
        {tiles.map((t) => (
          <button
            key={t.f}
            role="tab"
            aria-selected={filter === t.f}
            className={`tile ${t.cls} ${filter === t.f ? 'on' : ''}`}
            onClick={() => setFilter(t.f)}
          >
            <span className="tile-n">{t.n}</span>
            <span className="tile-label">{t.label}</span>
          </button>
        ))}
      </div>

      {retryable.length > 0 && (
        <div className="callout">
          <div className="callout-body">
            <strong>
              {retryable.length} polic{retryable.length === 1 ? 'y' : 'ies'} failed because of{' '}
              {retryable.every((j) => j.failure!.kind === 'connection')
                ? 'a connection problem on our side'
                : retryable.every((j) => j.failure!.kind === 'server')
                  ? 'a temporary error in the create-quote service'
                  : 'a connection or create-quote service problem'}
              .
            </strong>
            <p>
              {retryable.every((j) => j.failure!.kind === 'server')
                ? 'E012 / deadlock / 50x errors come from the wrapper or DuckCreek, not from the policy data. Retrying usually works, and fewer parallel sessions means fewer deadlocks. Use 🗄 DB response to see what DuckCreek actually returned.'
                : 'The connection probably broke (SSH/IAP drop, timeout or gateway error); the policy data itself looks fine. Retrying should work.'}
            </p>
            {payloadOnly.length > 0 && (
              <p className="small">
                {payloadOnly.length} already {payloadOnly.length === 1 ? 'has' : 'have'} a quote; retrying only re-fetches
                {payloadOnly.length === 1 ? ' its' : ' their'} payloads.
              </p>
            )}
            {riskyRetry.length > 0 && (
              <p className="small warn-text">
                ⚠ {riskyRetry.length} of them may have reached create-quote before failing (
                {riskyRetry.map((j) => j.policy).join(', ')}). Retrying could create a second quote for those.
              </p>
            )}
          </div>
          <div className="callout-actions">
            {retryNeedsPw(retryable) && (
              <input
                type="password"
                autoComplete="off"
                placeholder="Postgres password"
                value={props.pgPassword}
                onChange={(e) => props.setPgPassword(e.target.value)}
              />
            )}
            <button
              className="primary"
              disabled={working || (retryNeedsPw(retryable) && !props.pgPassword)}
              onClick={() => retry()}
            >
              Retry {retryable.length} polic{retryable.length === 1 ? 'y' : 'ies'}
            </button>
          </div>
        </div>
      )}
      {notRetryable.length > 0 && retryable.length === 0 && b.status !== 'running' && (
        <p className="muted small">
          You can still retry a single policy from its row (e.g. after fixing the Postgres password).
        </p>
      )}

      <div className="report-actions">
        <button
          className="ghost"
          onClick={() => act(() => downloadExcelReport(detail, `${fileBase}_report.xlsx`))}
          title="Policy numbers are stored as text, so Excel/Sheets show them exactly"
        >
          ⤓ Download report (Excel)
        </button>
        <button
          className="ghost"
          onClick={() => downloadText(`${fileBase}_report.csv`, csvReport(detail), 'text/csv')}
          title="Plain CSV for scripts. Excel shows 19-digit policy numbers as 2.8E+18; use the Excel download for that."
        >
          CSV
        </button>
        <button className="ghost" disabled={!quoteNumbers.length} onClick={() => copy(quoteNumbers.join('\n'))}>
          Copy quote numbers ({quoteNumbers.length})
        </button>
        <button className="ghost" disabled={!failedPolicies.length} onClick={() => copy(failedPolicies.join('\n'))}>
          Copy failed policies ({failedPolicies.length})
        </button>
        {failedPolicies.length > 0 && (
          <>
            <button
              className="ghost"
              disabled={working || (!props.pgConfigured && !props.pgPassword)}
              onClick={() => act(() => api.fetchDbLogs(b.id, undefined, props.pgPassword))}
              title="Look up the latest external_request / external_response in api_logs for every failed policy (no new create-quote call)"
            >
              🗄 Fetch DB responses ({failedPolicies.length})
            </button>
            {!props.pgConfigured && !props.pgPassword && (
              <input
                type="password"
                className="inline-pw"
                autoComplete="off"
                placeholder="Postgres password"
                value={props.pgPassword}
                onChange={(e) => props.setPgPassword(e.target.value)}
              />
            )}
          </>
        )}
        <span className="spacer" />
        {b.queued > 0 && (
          <button className="ghost" disabled={working} onClick={() => act(() => api.cancel(b.id))}>
            Cancel {b.queued} queued
          </button>
        )}
        {b.status !== 'running' && (
          <button
            className="ghost danger"
            disabled={working}
            onClick={() => {
              if (confirm(`Delete batch "${b.name}"? Saved payload files are kept.`)) {
                void api.remove(b.id).then(props.onDeleted, (e: Error) => setError(e.message))
              }
            }}
          >
            Delete batch
          </button>
        )}
      </div>
      {error && <small className="err">{error}</small>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Policy</th>
              <th>Result</th>
              <th>Quote number</th>
              {b.product === 'motor' ? (
                <th title="Premium = PurePremium + TaxesSurcharges">Premium</th>
              ) : (
                <>
                  <th>Premium</th>
                  <th title="Premium matched · cohort">Match · Cohort</th>
                </>
              )}
              <th>Payloads</th>
              <th>Time</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={b.product === 'motor' ? 7 : 8} className="muted">No policies in this view.</td>
              </tr>
            ) : (
              shown.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  now={now}
                  liveLabel={sessions.find((s) => s.id === j.session && s.activity.policy === j.policy)?.activity.label}
                  canRetry={!working && (!retryNeedsPw([j]) || !!props.pgPassword)}
                  onRetry={() => retry([j.id])}
                  onStop={(requeue) => act(() => api.stop(b.id, j.id, requeue))}
                  canFetchDb={!working && (props.pgConfigured || !!props.pgPassword)}
                  onFetchDb={() => act(() => api.fetchDbLogs(b.id, [j.id], props.pgPassword))}
                  onView={props.onView}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function JobRow(props: {
  job: Job
  now: number
  liveLabel?: string
  canRetry: boolean
  onRetry: () => void
  onStop: (requeue: boolean) => void
  canFetchDb: boolean
  onFetchDb: () => void
  onView: (v: Viewing) => void
}) {
  const { job: j } = props
  const q = j.result?.quote
  const d = jobDuration(j, props.now)

  let pill: React.ReactNode
  if (j.state === 'running') {
    pill = (
      <span className="result">
        <span className="pill running">Running · #{j.session}</span>
        {props.liveLabel && <span className="muted small live-step">{props.liveLabel}</span>}
      </span>
    )
  } else if (j.state === 'failed') {
    pill = <span className={`pill bad`}>Failed · {KIND_LABEL[j.failure!.kind]}</span>
  } else if (j.state === 'succeeded') {
    pill = <span className="pill good">Succeeded</span>
  } else if (j.state === 'cancelled') {
    pill = <span className="pill">{j.failure?.kind === 'stopped' ? 'Stopped' : 'Cancelled'}</span>
  } else if (j.retryAt) {
    const secs = Math.max(0, Math.ceil((Date.parse(j.retryAt) - props.now) / 1000))
    pill = (
      <span className="pill warn-pill" title={j.history.at(-1)?.failure.reason}>
        Auto-retry {j.autoRetries} in {secs}s
      </span>
    )
  } else {
    pill = <span className="pill">Queued</span>
  }

  return (
    <>
      <tr className={j.failure && (j.state === 'failed' || j.state === 'cancelled') ? 'has-detail' : ''}>
        <td className="mono">{j.policy}</td>
        <td className="result-cell">
          {pill}
          {j.attempts > 1 && <span className="muted small"> · try {j.attempts}</span>}
        </td>
        <td>
          {q?.quoteNumber ? (
            <span className="quote">
              <span className="mono">{q.quoteNumber}</span>
              <button className="ghost icon" title="Copy quote number" aria-label="Copy quote number" onClick={() => copy(q.quoteNumber!)}>
                ⧉
              </button>
            </span>
          ) : q ? (
            <button
              className="link"
              onClick={() =>
                props.onView(
                  q.rawFile
                    ? { title: `${j.policy} · create-quote response`, file: q.rawFile }
                    : { title: `${j.policy} · create-quote response`, content: q.raw },
                )
              }
            >
              View response
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        {j.product === 'motor' ? (
          <td className="num">
            {q?.premium ?? '—'}
            {q?.purePremium !== undefined && (
              <div className="muted small" title="PurePremium + TaxesSurcharges">
                {q.purePremium} + {q.taxes ?? '—'}
              </div>
            )}
          </td>
        ) : (
          <>
            <td className="num">{q?.premium ?? '—'}</td>
            <td>
              {q?.isPremiumMatched === undefined ? (
                <span className="muted">—</span>
              ) : (
                <>
                  <span className={q.isPremiumMatched === '1' ? 'ok-text' : 'err'}>{q.isPremiumMatched === '1' ? 'Yes' : 'No'}</span>
                  {q.cohortType && <span className="muted"> · {q.cohortType}</span>}
                </>
              )}
            </td>
          </>
        )}
        <td className="payload-cell">
          <PayloadLinks policy={j.policy} payloads={j.result?.payloads} onView={props.onView} />
        </td>
        <td className="num muted">{d === undefined ? '—' : fmtDuration(d)}</td>
        <td className="row-buttons">
          {j.state === 'running' && (
            <>
              <button className="ghost tiny danger" title="Kill this policy's job (its SSH session reconnects)" onClick={() => props.onStop(false)}>
                ■ Stop
              </button>
              <button className="ghost tiny" title="Stop it and put it back at the end of the queue" onClick={() => props.onStop(true)}>
                ⟲ Requeue
              </button>
            </>
          )}
          {j.state === 'queued' && (
            <>
              <button className="ghost tiny" title="Remove from the queue" onClick={() => props.onStop(false)}>
                ✕ Remove
              </button>
              <button className="ghost tiny" title="Move to the back of the queue" onClick={() => props.onStop(true)}>
                ↓ Later
              </button>
            </>
          )}
          {(j.state === 'failed' || j.state === 'cancelled') && (
            <button className="ghost tiny" disabled={!props.canRetry} onClick={props.onRetry} title="Add it to the queue again">
              ↻ {j.state === 'failed' ? 'Retry' : 'Requeue'}
            </button>
          )}
          {j.state === 'failed' && (
            <button
              className="ghost tiny"
              disabled={!props.canFetchDb || j.dbLogs?.state === 'queued' || j.dbLogs?.state === 'running'}
              onClick={props.onFetchDb}
              title={
                props.canFetchDb
                  ? 'Fetch the latest external_request / external_response from api_logs (no new create-quote call)'
                  : 'Enter the Postgres password first'
              }
            >
              🗄 DB
            </button>
          )}
        </td>
      </tr>
      {(j.state === 'failed' || (j.state === 'cancelled' && j.failure)) && j.failure && (
        <tr className="failure-row">
          <td colSpan={j.product === 'motor' ? 7 : 8}>
            <div className={`failure ${j.failure.kind === 'stopped' ? 'stopped' : ''}`}>
              <span>{j.failure.reason}</span>
              {RETRYABLE.includes(j.failure.kind) && !(j.failure.mayHaveRun && !q?.success) && (
                <span className="chip info">
                  {j.failure.kind === 'connection' ? 'Likely a broken connection: retry' : 'Temporary service error: retry may work'}
                </span>
              )}
              {j.failure.mayHaveRun && !q?.success && (RETRYABLE.includes(j.failure.kind) || j.failure.kind === 'stopped') && (
                <span className="chip warn">May have created a quote: check before retrying</span>
              )}
              {j.action === 'all' && q?.success && <span className="chip info">Quote created; retry fetches payloads only</span>}
            </div>
            {j.result?.externalError && (
              <div className="external">
                <span className="external-label">{externalSource(j.result.payloads)}:</span> {j.result.externalError}
              </div>
            )}
            {j.dbLogs && <DbLogsLine policy={j.policy} logs={j.dbLogs} onView={props.onView} />}
            {j.history.length > 0 && (
              <details className="history">
                <summary className="small muted">{j.history.length} earlier attempt{j.history.length === 1 ? '' : 's'}</summary>
                <ul>
                  {j.history.map((h) => (
                    <li key={h.attempt} className="small">
                      Try {h.attempt} ({h.action}, #{h.session ?? '—'}, {fmtTime(h.finishedAt)}): {KIND_LABEL[h.failure.kind]}:{' '}
                      {h.failure.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </td>
        </tr>
      )}
      {j.state === 'succeeded' && j.history.length > 0 && (
        <tr className="failure-row">
          <td colSpan={j.product === 'motor' ? 7 : 8}>
            <details className="history">
              <summary className="small muted">
                Succeeded on try {j.attempts} · {j.history.length} earlier failure{j.history.length === 1 ? '' : 's'}
              </summary>
              <ul>
                {j.history.map((h) => (
                  <li key={h.attempt} className="small">
                    Try {h.attempt}: {KIND_LABEL[h.failure.kind]}: {h.failure.reason}
                  </li>
                ))}
              </ul>
            </details>
          </td>
        </tr>
      )}
    </>
  )
}

/** Result of an on-demand api_logs lookup for a failed policy. */
function DbLogsLine({ policy, logs, onView }: { policy: string; logs: DbLogs; onView: (v: Viewing) => void }) {
  if (logs.state === 'queued' || logs.state === 'running') {
    return <div className="external muted">🗄 {logs.state === 'queued' ? 'Waiting for a session to fetch the DB response…' : 'Fetching DB response from api_logs…'}</div>
  }
  const when = logs.fetchedAt ? ` (fetched ${fmtTime(logs.fetchedAt)})` : ''
  return (
    <div className={`external ${logs.state === 'error' ? 'err' : ''}`}>
      <span className="external-label">🗄 DB response{when}:</span>{' '}
      {logs.state === 'error' ? logs.error : (logs.summary ?? 'no error text found in external_response, open it to check')}
      {' '}
      <PayloadLinks policy={policy} payloads={logs.payloads} onView={onView} small />
    </div>
  )
}

/**
 * Links to saved api_logs payloads. Health: Request · Response.
 * Motor: grouped as "DC req resp · Blaze req resp" (two calls per attempt).
 */
function PayloadLinks(props: { policy: string; payloads?: PayloadResult[]; onView: (v: Viewing) => void; small?: boolean }) {
  const { policy, payloads, onView } = props
  if (!payloads?.length) return <span className="muted">—</span>
  if (payloads.every((p) => !p.file)) return <span className="muted small">No row</span>
  const link = (p: PayloadResult, text: string) =>
    p.file ? (
      <button
        key={p.kind}
        className={`link ${props.small ? 'small-link' : ''}`}
        onClick={() => onView({ title: `${policy} · ${PAYLOAD_LABEL[p.kind] ?? p.kind}`, file: p.file })}
        title={p.status === 'not-json' ? 'Stored as plain text (not JSON)' : undefined}
      >
        {text}
        {p.status === 'not-json' && ' (raw)'}
      </button>
    ) : (
      <span key={p.kind} className="muted small" title="NULL in api_logs">
        {text}: null{' '}
      </span>
    )
  const byKind = (k: string) => payloads.find((p) => p.kind === k)
  if (!byKind('dc_request') && !byKind('blaze_request')) {
    return <>{payloads.map((p) => link(p, PAYLOAD_LABEL[p.kind] ?? p.kind))}</>
  }
  const group = (name: string, req?: PayloadResult, resp?: PayloadResult) => (
    <span className="payload-group">
      <span className="muted small">{name}</span> {req && link(req, 'req')} {resp && link(resp, 'resp')}
    </span>
  )
  return (
    <>
      {group('DC', byKind('dc_request'), byKind('dc_response'))}
      {group('Blaze', byKind('blaze_request'), byKind('blaze_response'))}
    </>
  )
}

/** Which saved response the error text came from (same priority as the backend's summary). */
function externalSource(payloads?: PayloadResult[]): string {
  const has = (k: string) => payloads?.some((p) => p.kind === k && p.file)
  if (has('response') || has('dc_response')) return 'DuckCreek response'
  if (has('blaze_response')) return 'Blaze response'
  return 'External response'
}
