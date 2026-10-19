import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityLog, SessionCards } from './Activity'
import { api, type ActivityEvent, type AppState, type BatchStatus, type Settings, type Status } from './api'
import { BatchDetailView, BatchList, Composer } from './Batches'
import { JsonViewer, Toasts, type Toast, type Viewing } from './ui'

// Poll fast while anything is running, slowly otherwise (keeps session state fresh).
const POLL_BUSY_MS = 1000
const POLL_IDLE_MS = 4000
const MAX_LOG_LINES = 500

/** Concurrency (1..max parallel SSH sessions) and auto-retry count; applied immediately. */
function SettingsBar({ settings, onChange }: { settings: Settings; onChange: (p: Partial<Settings>) => void }) {
  return (
    <div className="settings-bar">
      <div className="setting">
        <span className="small muted" id="conc-label" title="How many policies run at once (one SSH session each)">
          Parallel sessions
        </span>
        <div className="segmented small-seg" role="radiogroup" aria-labelledby="conc-label">
          {Array.from({ length: settings.maxSessions }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={settings.concurrency === n}
              className={settings.concurrency === n ? 'on' : ''}
              onClick={() => settings.concurrency !== n && onChange({ concurrency: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <label className="setting" title="Automatic retries for transient create-quote errors (deadlock, E012, 502/503/504), with backoff">
        <span className="small muted">Auto-retry</span>
        <select value={settings.autoRetries} onChange={(e) => onChange({ autoRetries: Number(e.target.value) })}>
          {Array.from({ length: settings.maxAutoRetries + 1 }, (_, i) => i).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Off' : `${n}×`}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [apiError, setApiError] = useState('')
  const [state, setState] = useState<AppState | null>(null)
  // Selected batch lives in the URL (#batch=<id>) so reloads and bookmarks keep it.
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => new URLSearchParams(location.hash.slice(1)).get('batch') ?? undefined,
  )
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [pgPassword, setPgPassword] = useState('')
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [reconnecting, setReconnecting] = useState(false)

  const lastSeq = useRef(0)
  const selectedRef = useRef<string | undefined>(undefined)
  selectedRef.current = selectedId
  const prevStatus = useRef<Map<string, BatchStatus> | null>(null)
  const toastId = useRef(0)

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current
    setToasts((ts) => [...ts, { ...t, id }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 12000)
  }, [])

  const refreshStatus = useCallback(() => {
    api.status().then(setStatus).catch((e: Error) => setApiError(e.message))
  }, [])

  const refresh = useCallback(async () => {
    try {
      let s = await api.state(lastSeq.current, selectedRef.current)
      if (s.lastSeq < lastSeq.current) {
        // Server restarted: its event counter reset, so start the log over.
        lastSeq.current = 0
        setEvents([])
        s = await api.state(0, selectedRef.current)
      }
      if (s.events.length) {
        lastSeq.current = s.events[s.events.length - 1].seq
        setEvents((prev) => [...prev, ...s.events].slice(-MAX_LOG_LINES))
      }

      // Tell the user when a batch finishes (not for batches that were already done on load).
      const prev = prevStatus.current
      if (prev) {
        for (const b of s.batches) {
          if (prev.get(b.id) === 'running' && b.status !== 'running') {
            pushToast({
              tone: b.failed ? (b.retryable ? 'warn' : 'bad') : b.status === 'cancelled' ? 'warn' : 'good',
              title: `Batch "${b.name}" finished`,
              body:
                `${b.succeeded} succeeded, ${b.failed} failed` +
                (b.retryable ? ` (${b.retryable} worth retrying)` : '') +
                (b.cancelled ? `, ${b.cancelled} cancelled` : ''),
              action: { label: 'View report', onClick: () => setSelectedId(b.id) },
            })
          }
        }
      }
      prevStatus.current = new Map(s.batches.map((b) => [b.id, b.status]))

      // Keep a valid selection: default to the newest batch.
      if (!selectedRef.current || !s.batches.some((b) => b.id === selectedRef.current)) {
        setSelectedId(s.batches[0]?.id)
      }
      setState(s)
      setApiError('')
    } catch (e) {
      setApiError((e as Error).message)
    }
  }, [pushToast])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const hash = selectedId ? `#batch=${selectedId}` : ''
    if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname)
  }, [selectedId])

  const busy = !!state && (state.pending > 0 || state.sessions.some((s) => s.state === 'connecting'))
  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(t)
  }, [busy, refresh, selectedId])

  const runningBatches = state?.batches.filter((b) => b.status === 'running').length ?? 0
  useEffect(() => {
    document.title = runningBatches ? `(${runningBatches} running) DC UAT Console` : 'DC UAT Console'
  }, [runningBatches])

  const sessions = state?.sessions ?? status?.sessions ?? []
  const connected = sessions.filter((s) => s.state === 'connected').length
  const connecting = sessions.some((s) => s.state === 'connecting')
  const failed = sessions.filter((s) => s.state === 'disconnected' && s.lastError)
  const sessionClass = failed.length && !connected ? 'bad' : connecting ? 'running' : connected ? 'good' : ''
  const selected = state?.selected?.summary.id === selectedId ? state?.selected : null
  const pgConfigured = !!status?.pgPasswordConfigured

  const runningNow = state?.batches.reduce((n, b) => n + b.running, 0) ?? 0
  const vmBusy = reconnecting || !!state?.vmBusy

  /** Full reset: close every SSH session, log in to the VM again, resume the queue. */
  async function reconnectVm() {
    if (
      runningNow &&
      !confirm(`${runningNow} running polic${runningNow === 1 ? 'y' : 'ies'} will be stopped and put back in the queue. Reconnect to the VM?`)
    ) {
      return
    }
    setReconnecting(true)
    try {
      await api.vmReconnect()
      pushToast({ tone: 'good', title: 'Reconnected to the VM', body: 'Fresh SSH login on session #1; the others open when needed.' })
    } catch (e) {
      pushToast({ tone: 'bad', title: 'Reconnect failed', body: (e as Error).message })
    } finally {
      setReconnecting(false)
      void refresh()
      refreshStatus()
    }
  }

  async function disconnectVm() {
    try {
      await api.vmDisconnect()
      pushToast({ tone: 'warn', title: 'Disconnected from the VM', body: 'All SSH sessions closed. Starting a batch reconnects automatically.' })
    } catch (e) {
      pushToast({ tone: 'bad', title: 'Could not disconnect', body: (e as Error).message })
    } finally {
      void refresh()
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>DC UAT Console</h1>
          <p className="sub">Create quotes and pull DuckCreek api_logs payloads from the UAT VM, in batches</p>
        </div>
        <div className="status">
          {apiError && <span className="pill bad">API unreachable: {apiError}</span>}
          {status && (
            <span className={`pill ${status.gcloud.ok ? 'good' : 'bad'}`} title={status.gcloud.detail}>
              gcloud: {status.gcloud.ok ? status.gcloud.account || 'ok' : status.gcloud.detail}
            </span>
          )}
          {sessions.length > 0 && (
            <span className={`pill ${sessionClass}`}>
              SSH: {connected}/{state?.settings.concurrency ?? sessions.length} connected{connecting && ' (connecting…)'}
              {status && ` · ${status.vm.local ? 'local' : status.vm.name}`}
            </span>
          )}
          <button
            className="ghost"
            onClick={reconnectVm}
            disabled={vmBusy}
            title="Close every SSH session, log in to the VM again and resume the queue"
          >
            {vmBusy ? 'Reconnecting…' : '⟳ Reconnect VM'}
          </button>
          <button
            className="ghost"
            onClick={disconnectVm}
            disabled={vmBusy || (state?.pending ?? 0) > 0 || connected === 0}
            title={(state?.pending ?? 0) > 0 ? 'Stop or cancel running/queued policies first' : 'Close all SSH sessions to the VM'}
          >
            Disconnect
          </button>
          <button className="ghost" onClick={refreshStatus}>Refresh</button>
        </div>
      </header>

      {failed.length > 0 && (
        <div className="banner bad">
          <strong>
            {failed.length === 1 ? `SSH session #${failed[0].id} is down.` : `${failed.length} SSH sessions are down.`}
          </strong>{' '}
          {connected > 0 ? 'Batches keep running on the connected sessions. ' : ''}
          Down sessions reconnect automatically on their next job, or click Reconnect VM.
          <pre>{failed.map((s) => `#${s.id}: ${s.lastError}`).join('\n')}</pre>
        </div>
      )}

      <div className="layout">
        <aside className="side">
          <Composer
            pgPassword={pgPassword}
            setPgPassword={setPgPassword}
            pgConfigured={pgConfigured}
            onCreated={(b) => {
              setSelectedId(b.summary.id)
              void refresh()
            }}
          />
          <BatchList batches={state?.batches ?? []} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        <main className="main">
          {selected ? (
            <BatchDetailView
              detail={selected}
              sessions={sessions}
              pgPassword={pgPassword}
              setPgPassword={setPgPassword}
              pgConfigured={pgConfigured}
              onView={setViewing}
              onChanged={() => void refresh()}
              onDeleted={() => {
                setSelectedId(undefined)
                void refresh()
              }}
            />
          ) : (
            <section className="card empty">
              <h2>{state?.batches.length ? 'Loading batch…' : 'No batches yet'}</h2>
              <p className="muted">
                Paste policy numbers on the left and start a batch. Each batch gets a report of which policies succeeded and
                which failed, and failures caused by a broken connection can be retried in one click.
              </p>
            </section>
          )}
        </main>
      </div>

      {sessions.length > 0 && (
        <section className="card">
          <div className="card-head wrap">
            <div>
              <h2>SSH sessions</h2>
              <span className="muted small">What each session is doing right now</span>
            </div>
            {state?.settings && (
              <SettingsBar
                settings={state.settings}
                onChange={async (patch) => {
                  try {
                    await api.updateSettings(patch)
                  } catch (e) {
                    pushToast({ tone: 'bad', title: 'Could not change setting', body: (e as Error).message })
                  }
                  void refresh()
                }}
              />
            )}
          </div>
          <SessionCards sessions={sessions} />
        </section>
      )}

      <ActivityLog events={events} sessions={sessions} batchId={selectedId} />

      {viewing && <JsonViewer viewing={viewing} onClose={() => setViewing(null)} />}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
    </div>
  )
}
