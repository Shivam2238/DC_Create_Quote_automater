import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityLog, SessionCards } from './Activity'
import {
  api,
  type Action,
  type ActivityEvent,
  type Job,
  type JobsSnapshot,
  type PayloadResult,
  type SavedFile,
  type SessionInfo,
  type Status,
} from './api'

interface Viewing {
  title: string
  fileName: string
  content: unknown
}

const ACTIONS: { value: Action; label: string }[] = [
  { value: 'quote', label: 'Create quote' },
  { value: 'payloads', label: 'Fetch payloads' },
  { value: 'all', label: 'Both' },
]

// Poll fast while the queue is busy, slowly otherwise (keeps the session pill fresh).
const POLL_BUSY_MS = 1000
const POLL_IDLE_MS = 5000
const MAX_LOG_LINES = 500

function sessionTooltip(s: SessionInfo): string {
  const since = s.connectedAt ? ` since ${new Date(s.connectedAt).toLocaleTimeString()}` : ''
  return `#${s.id}: ${s.state}${since}${s.lastError ? ` (${s.lastError})` : ''}`
}

function duration(job: Job, now: number): string {
  if (!job.startedAt) return '—'
  const ms = (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)
  return `${(ms / 1000).toFixed(1)}s`
}

function parsePolicies(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))]
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text)
}

function download(fileName: string, content: unknown) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n'
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName })
  a.click()
  URL.revokeObjectURL(url)
}

const baseName = (p?: string) => p?.split('/').pop() ?? ''

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState('')
  const [policiesText, setPoliciesText] = useState('')
  const [action, setAction] = useState<Action>('quote')
  const [pgPassword, setPgPassword] = useState('')
  const [snapshot, setSnapshot] = useState<JobsSnapshot | null>(null)
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [files, setFiles] = useState<SavedFile[]>([])
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const lastSeq = useRef(0)

  const refreshStatus = useCallback(() => {
    setStatusError('')
    api.status().then(setStatus).catch((e: Error) => setStatusError(e.message))
  }, [])
  const refreshFiles = useCallback(() => {
    api.files().then(setFiles).catch(() => setFiles([]))
  }, [])
  const refreshJobs = useCallback(async () => {
    try {
      let s = await api.jobs(lastSeq.current)
      if (s.lastSeq < lastSeq.current) {
        // Server restarted: its event counter reset, so start the log over.
        lastSeq.current = 0
        setEvents([])
        s = await api.jobs(0)
      }
      if (s.events.length) {
        lastSeq.current = s.events[s.events.length - 1].seq
        setEvents((prev) => [...prev, ...s.events].slice(-MAX_LOG_LINES))
      }
      setSnapshot(s)
      setStatusError('')
    } catch (e) {
      setStatusError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshFiles()
  }, [refreshStatus, refreshFiles])

  const busy = !!snapshot && (snapshot.pending > 0 || snapshot.sessions.some((s) => s.state === 'connecting'))
  useEffect(() => {
    void refreshJobs()
    const t = setInterval(refreshJobs, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(t)
  }, [busy, refreshJobs])

  // Refresh the saved-files list whenever another payload job finishes.
  const payloadJobsDone = snapshot?.jobs.filter((j) => j.state === 'done' && j.result?.payloads).length ?? 0
  const lastPayloadJobsDone = useRef(0)
  useEffect(() => {
    if (payloadJobsDone !== lastPayloadJobsDone.current) refreshFiles()
    lastPayloadJobsDone.current = payloadJobsDone
  }, [payloadJobsDone, refreshFiles])

  const policies = useMemo(() => parsePolicies(policiesText), [policiesText])
  const invalid = policies.filter((p) => !/^\d+$/.test(p))
  const needsPassword = action !== 'quote' && !status?.pgPasswordConfigured
  const canSubmit = !submitting && policies.length > 0 && invalid.length === 0 && (!needsPassword || !!pgPassword)

  async function submit() {
    setSubmitting(true)
    setSubmitError('')
    try {
      await api.enqueue(policies, action, pgPassword)
      setPoliciesText('')
      await refreshJobs()
    } catch (e) {
      setSubmitError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function reconnect() {
    setReconnecting(true)
    try {
      await api.reconnect()
    } finally {
      setReconnecting(false)
      void refreshJobs()
    }
  }

  const sessions = snapshot?.sessions ?? status?.sessions ?? []
  const connected = sessions.filter((s) => s.state === 'connected').length
  const connecting = sessions.some((s) => s.state === 'connecting')
  const failed = sessions.filter((s) => s.state === 'disconnected' && s.lastError)
  const sessionClass = failed.length && !connected ? 'bad' : connecting ? 'running' : connected ? 'good' : ''
  const now = Date.now() // re-rendered by polling, so running durations tick
  const jobs = useMemo(() => [...(snapshot?.jobs ?? [])].reverse(), [snapshot]) // newest first
  const queued = jobs.filter((j) => j.state === 'queued').length
  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'error').length
  const quoteNumbers = jobs.map((j) => j.result?.quote?.quoteNumber).filter(Boolean) as string[]

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>DC UAT Console</h1>
          <p className="sub">Create quotes and pull DuckCreek api_logs payloads from the UAT VM</p>
        </div>
        <div className="status">
          {statusError && <span className="pill bad">API unreachable: {statusError}</span>}
          {status && (
            <span className={`pill ${status.gcloud.ok ? 'good' : 'bad'}`} title={status.gcloud.detail}>
              gcloud: {status.gcloud.ok ? status.gcloud.account || 'ok' : status.gcloud.detail}
            </span>
          )}
          {sessions.length > 0 && (
            <span className={`pill ${sessionClass}`} title={sessions.map(sessionTooltip).join('\n')}>
              SSH sessions: {connected}/{sessions.length} connected
              {connecting && ' (connecting…)'}
              {status && ` · ${status.vm.local ? 'local' : status.vm.name}`}
            </span>
          )}
          {failed.length > 0 && (
            <button className="ghost" onClick={reconnect} disabled={reconnecting || connecting}>
              {reconnecting ? 'Reconnecting…' : 'Reconnect'}
            </button>
          )}
          <button className="ghost" onClick={refreshStatus}>Refresh</button>
        </div>
      </header>

      {failed.length > 0 && (
        <div className="banner bad">
          <strong>
            {failed.length === 1 ? `SSH session #${failed[0].id} is down.` : `${failed.length} SSH sessions are down.`}
          </strong>{' '}
          {connected > 0 ? 'The queue keeps running on the connected sessions. ' : ''}
          Down sessions reconnect automatically on their next job, or click Reconnect.
          <pre>{failed.map((s) => `#${s.id}: ${s.lastError}`).join('\n')}</pre>
        </div>
      )}

      <section className="card">
        <label className="field">
          <span>Policy numbers</span>
          <textarea
            rows={4}
            placeholder={'1234567890123456789\nOne per line, or separated by commas/spaces'}
            value={policiesText}
            onChange={(e) => setPoliciesText(e.target.value)}
          />
          <small className={invalid.length ? 'err' : 'muted'}>
            {invalid.length
              ? `Not a valid policy number: ${invalid.join(', ')}`
              : `${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}`}
          </small>
        </label>

        <div className="controls">
          <div className="segmented" role="radiogroup" aria-label="Action">
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
              className="pw"
              autoComplete="off"
              placeholder={status?.pgPasswordConfigured ? 'Postgres password (using server .env)' : 'Postgres password'}
              value={pgPassword}
              onChange={(e) => setPgPassword(e.target.value)}
            />
          )}

          <button className="primary" disabled={!canSubmit} onClick={submit}>
            {snapshot?.pending ? 'Add to queue' : 'Run'}
          </button>
        </div>
        {submitError && <small className="err">{submitError}</small>}
      </section>

      {sessions.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>SSH sessions</h2>
            <span className="muted small">What each session is doing right now</span>
          </div>
          <SessionCards sessions={sessions} jobs={snapshot?.jobs ?? []} />
        </section>
      )}

      {jobs.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>
              Queue{' '}
              <span className="muted small">
                {snapshot?.pending ? `${snapshot.pending} pending · ` : ''}
                {finished}/{jobs.length} finished
              </span>
            </h2>
            <div className="viewer-actions">
              {quoteNumbers.length > 0 && (
                <button className="ghost" onClick={() => copy(quoteNumbers.join('\n'))}>
                  Copy quote numbers
                </button>
              )}
              {queued > 0 && (
                <button className="ghost" onClick={() => api.cancelQueued().then(refreshJobs)}>
                  Cancel queued ({queued})
                </button>
              )}
              {finished > 0 && (
                <button className="ghost" onClick={() => api.clearFinished().then(refreshJobs)}>
                  Clear finished
                </button>
              )}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Quote number</th>
                  <th>Premium</th>
                  <th>Matched</th>
                  <th>Cohort</th>
                  <th>Payloads</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <ResultRow key={j.id} job={j} now={now} onView={setViewing} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ActivityLog events={events} sessions={sessions} />

      <section className="card">
        <div className="card-head">
          <h2>Saved payload files</h2>
          <button className="ghost" onClick={refreshFiles}>Refresh</button>
        </div>
        {status && <p className="muted small mono">{status.outDir}</p>}
        {files.length === 0 ? (
          <p className="muted">No payload files saved yet.</p>
        ) : (
          <ul className="files">
            {files.map((f) => (
              <li key={f.name}>
                <a href={api.fileUrl(f.name)} className="mono">{f.name}</a>
                <span className="muted small">
                  {(f.size / 1024).toFixed(1)} KB · {new Date(f.modified).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {viewing && <JsonViewer viewing={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

const ACTION_LABEL: Record<Action, string> = { quote: 'Quote', payloads: 'Payloads', all: 'Both' }

function ResultRow({ job: row, now, onView }: { job: Job; now: number; onView: (v: Viewing) => void }) {
  const q = row.result?.quote
  const quoteFailed = row.state === 'done' && q && !q.success
  const stateLabel = quoteFailed ? 'quote failed' : row.error === 'cancelled' ? 'cancelled' : row.state
  const stateClass = row.state === 'error' || quoteFailed ? 'bad' : row.state === 'done' ? 'good' : row.state

  const viewPayload = (p: PayloadResult) =>
    onView({ title: `${row.policy} · ${p.kind}`, fileName: baseName(p.file), content: p.content })

  return (
    <>
      <tr>
        <td className="mono">{row.policy}</td>
        <td className="muted">{ACTION_LABEL[row.action]}</td>
        <td>
          <span className={`pill ${stateClass}`}>{stateLabel}</span>
          {row.session && <span className="muted small"> #{row.session}</span>}
        </td>
        <td className="num muted">{duration(row, now)}</td>
        <td>
          {q?.quoteNumber ? (
            <span className="quote">
              <span className="mono">{q.quoteNumber}</span>
              <button className="ghost tiny" onClick={() => copy(q.quoteNumber!)}>Copy</button>
            </span>
          ) : q ? (
            <button
              className="link"
              onClick={() =>
                onView({
                  title: `${row.policy} · create-quote response`,
                  fileName: `${row.policy}_quote_response.json`,
                  content: q.raw,
                })
              }
            >
              View response
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="num">{q?.premium ?? '—'}</td>
        <td>{q?.isPremiumMatched === undefined ? '—' : q.isPremiumMatched === '1' ? 'Yes' : 'No'}</td>
        <td>{q?.cohortType ?? '—'}</td>
        <td>
          {row.result?.payloads ? (
            row.result.payloads.map((p) =>
              p.status === 'null' ? (
                <span key={p.kind} className="muted small">{p.kind}: null </span>
              ) : (
                <button key={p.kind} className="link" onClick={() => viewPayload(p)}>
                  {p.kind === 'request' ? 'Request' : 'Response'}
                  {p.status === 'not-json' && ' (raw)'}
                </button>
              ),
            )
          ) : row.result?.message ? (
            <span className="muted small">{row.result.message}</span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      </tr>
      {row.error && row.error !== 'cancelled' && (
        <tr className="error-row">
          <td colSpan={9}>
            <pre>{row.error}</pre>
          </td>
        </tr>
      )}
    </>
  )
}

function JsonViewer({ viewing, onClose }: { viewing: Viewing; onClose: () => void }) {
  const text = typeof viewing.content === 'string' ? viewing.content : JSON.stringify(viewing.content, null, 2)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="viewer" role="dialog" aria-label={viewing.title} onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <h2 className="mono">{viewing.title}</h2>
          <div className="viewer-actions">
            <button className="ghost" onClick={() => copy(text)}>Copy</button>
            <button className="ghost" onClick={() => download(viewing.fileName, viewing.content)}>Download</button>
            <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <pre className="json">{text}</pre>
      </div>
    </div>
  )
}
