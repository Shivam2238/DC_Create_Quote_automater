import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  RETRYABLE,
  type Action,
  type BatchDetail,
  type BatchSummary,
  type FailureKind,
  type Job,
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

function previewName(d: Date): string {
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  return `${date} · ${d.toLocaleTimeString('en-GB', { hour12: false })}`
}

// ---------------------------------------------------------------- composer

export function Composer(props: {
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

  const policies = useMemo(() => parsePolicies(text), [text])
  const invalid = policies.filter((p) => !/^\d+$/.test(p))
  const needsPw = action !== 'quote' && !props.pgConfigured
  const canStart = !busy && policies.length > 0 && !invalid.length && (!needsPw || !!props.pgPassword)

  async function start() {
    if (!canStart) return
    setBusy(true)
    setError('')
    try {
      const b = await api.createBatch(policies, action, name.trim(), props.pgPassword)
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
    <section className="card composer">
      <h2>New batch</h2>
      <label className="field">
        <span>Name <span className="muted small">(optional)</span></span>
        <input value={name} maxLength={100} placeholder={previewName(new Date(now))} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Policy numbers</span>
        <textarea
          rows={5}
          placeholder={'1234567890123456789\nOne per line, or separated by commas/spaces'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && start()}
        />
        <small className={invalid.length ? 'err' : 'muted'}>
          {invalid.length
            ? `Not a valid policy number: ${invalid.join(', ')}`
            : `${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} · Ctrl+Enter to start`}
        </small>
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
        {busy ? 'Starting…' : `Start batch${policies.length ? ` (${policies.length})` : ''}`}
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

export function BatchList(props: { batches: BatchSummary[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <section className="card batch-list">
      <h2>
        Batches <span className="muted small">{props.batches.length}</span>
      </h2>
      {props.batches.length === 0 ? (
        <p className="muted small">No batches yet. Start one above.</p>
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

function csvReport(detail: BatchDetail): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    'policy_number', 'status', 'failure_type', 'failure_reason', 'may_have_created_quote', 'quote_number', 'premium',
    'premium_matched', 'cohort', 'http_status', 'request_payload', 'response_payload', 'attempts', 'session',
    'started_at', 'finished_at', 'duration_s',
  ]
  const rows = detail.jobs.map((j) => {
    const q = j.result?.quote
    const p = (k: string) => j.result?.payloads?.find((x) => x.kind === k)
    const d = j.startedAt && j.finishedAt ? ((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000).toFixed(1) : ''
    return [
      j.policy, j.state, j.failure ? KIND_LABEL[j.failure.kind] : '', j.failure?.reason, j.failure ? (j.failure.mayHaveRun ? 'yes' : 'no') : '',
      q?.quoteNumber, q?.premium, q?.isPremiumMatched === undefined ? '' : q.isPremiumMatched === '1' ? 'yes' : 'no',
      q?.cohortType, q?.httpStatus, p('request')?.file ?? p('request')?.status, p('response')?.file ?? p('response')?.status,
      j.attempts, j.session, j.startedAt, j.finishedAt, d,
    ].map(esc).join(',')
  })
  return [header.join(','), ...rows].join('\n') + '\n'
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
              {retryable.length} polic{retryable.length === 1 ? 'y' : 'ies'} failed because of a{' '}
              {retryable.every((j) => j.failure!.kind === 'connection') ? 'connection problem on our side' : 'connection or server problem'}
              .
            </strong>
            <p>
              The connection probably broke (SSH/IAP drop, timeout or gateway error); the policy data itself looks fine.
              Retrying should work.
            </p>
            {payloadOnly.length > 0 && (
              <p className="small">
                {payloadOnly.length} already {payloadOnly.length === 1 ? 'has' : 'have'} a quote; retrying only re-fetches
                {payloadOnly.length === 1 ? ' its' : ' their'} payloads.
              </p>
            )}
            {riskyRetry.length > 0 && (
              <p className="small warn-text">
                ⚠ {riskyRetry.length} of them may have reached create-quote before the connection broke (
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
        <button className="ghost" onClick={() => downloadText(`${b.name.replace(/[^\w.-]+/g, '_')}_report.csv`, csvReport(detail), 'text/csv')}>
          ⤓ Download report (CSV)
        </button>
        <button className="ghost" disabled={!quoteNumbers.length} onClick={() => copy(quoteNumbers.join('\n'))}>
          Copy quote numbers ({quoteNumbers.length})
        </button>
        <button className="ghost" disabled={!failedPolicies.length} onClick={() => copy(failedPolicies.join('\n'))}>
          Copy failed policies ({failedPolicies.length})
        </button>
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
              <th>Premium</th>
              <th title="Premium matched · cohort">Match · Cohort</th>
              <th>Payloads</th>
              <th>Time</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">No policies in this view.</td>
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
            <button className="link" onClick={() => props.onView({ title: `${j.policy} · create-quote response`, content: q.raw })}>
              View response
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
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
        <td>
          {j.result?.payloads?.length && j.result.payloads.every((p) => !p.file) ? (
            <span className="muted small">No row</span>
          ) : j.result?.payloads?.length ? (
            j.result.payloads.map((p) =>
              p.file ? (
                <button key={p.kind} className="link" onClick={() => props.onView({ title: `${j.policy} · ${p.kind}`, file: p.file })}>
                  {p.kind === 'request' ? 'Request' : 'Response'}
                  {p.status === 'not-json' && ' (raw)'}
                </button>
              ) : (
                <span key={p.kind} className="muted small">{p.kind === 'request' ? 'Req' : 'Resp'}: null </span>
              ),
            )
          ) : (
            <span className="muted">—</span>
          )}
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
        </td>
      </tr>
      {(j.state === 'failed' || (j.state === 'cancelled' && j.failure)) && j.failure && (
        <tr className="failure-row">
          <td colSpan={8}>
            <div className={`failure ${j.failure.kind === 'stopped' ? 'stopped' : ''}`}>
              <span>{j.failure.reason}</span>
              {RETRYABLE.includes(j.failure.kind) && !(j.failure.mayHaveRun && !q?.success) && (
                <span className="chip info">Likely a broken connection: retry</span>
              )}
              {j.failure.mayHaveRun && !q?.success && (RETRYABLE.includes(j.failure.kind) || j.failure.kind === 'stopped') && (
                <span className="chip warn">May have created a quote: check before retrying</span>
              )}
              {j.action === 'all' && q?.success && <span className="chip info">Quote created; retry fetches payloads only</span>}
            </div>
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
          <td colSpan={8}>
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
