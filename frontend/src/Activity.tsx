import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Action, ActivityEvent, Job, Phase, SessionInfo } from './api'

const STEPS: Record<Action, { phase: Phase; label: string }[]> = {
  quote: [
    { phase: 'starting', label: 'Start' },
    { phase: 'quote', label: 'Create quote' },
  ],
  payloads: [
    { phase: 'starting', label: 'Start' },
    { phase: 'payload', label: 'Query Postgres' },
    { phase: 'saving', label: 'Save files' },
  ],
  all: [
    { phase: 'starting', label: 'Start' },
    { phase: 'quote', label: 'Create quote' },
    { phase: 'payload', label: 'Query Postgres' },
    { phase: 'saving', label: 'Save files' },
  ],
}

const PHASE_CLASS: Record<Phase, string> = {
  disconnected: 'off',
  connecting: 'connecting',
  idle: 'idle',
  starting: 'busy',
  quote: 'busy',
  payload: 'busy',
  saving: 'busy',
}

function elapsed(since: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(since)) / 1000)
  if (s < 60) return `${s.toFixed(1)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** Re-render every `ms` so timers tick between polls. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function SessionCards({ sessions, jobs }: { sessions: SessionInfo[]; jobs: Job[] }) {
  const now = useNow(250)
  return (
    <div className="sessions">
      {sessions.map((s) => {
        const a = s.activity
        const job = jobs.find((j) => j.state === 'running' && j.session === s.id)
        const steps = job ? STEPS[job.action] : []
        const current = steps.findIndex((st) => st.phase === a.phase)
        return (
          <div key={s.id} className={`session ${PHASE_CLASS[a.phase]}`}>
            <div className="session-head">
              <span className="dot" aria-hidden />
              <strong>#{s.id}</strong>
              <span className="muted small">{s.state}</span>
              <span className="muted small timer" title={`since ${new Date(a.since).toLocaleTimeString()}`}>
                {elapsed(a.since, now)}
              </span>
            </div>
            <div className="session-label">{a.label}</div>
            {a.policy && PHASE_CLASS[a.phase] !== 'idle' && <div className="mono small">{a.policy}</div>}
            {steps.length > 0 && (
              <ol className="steps" aria-label="Job progress">
                {steps.map((st, i) => (
                  <li key={st.phase} className={i < current ? 'done' : i === current ? 'active' : ''}>
                    {st.label}
                  </li>
                ))}
              </ol>
            )}
            {s.state === 'disconnected' && s.lastError && (
              <div className="err small clamp" title={s.lastError}>{s.lastError}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ActivityLog({ events, sessions }: { events: ActivityEvent[]; sessions: SessionInfo[] }) {
  const [filter, setFilter] = useState<number | 'all'>('all')
  const boxRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const shown = filter === 'all' ? events : events.filter((e) => e.session === filter)

  // Follow new lines like a terminal, unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight
  }, [shown.length, filter])

  return (
    <section className="card">
      <div className="card-head">
        <h2>Activity log</h2>
        <div className="segmented small-seg" role="radiogroup" aria-label="Filter by session">
          {(['all', ...sessions.map((s) => s.id)] as const).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filter === f}
              className={filter === f ? 'on' : ''}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : `#${f}`}
            </button>
          ))}
        </div>
      </div>
      <div
        className="log"
        ref={boxRef}
        onScroll={(e) => {
          const b = e.currentTarget
          stickToBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24
        }}
      >
        {shown.length === 0 ? (
          <div className="muted">No activity yet.</div>
        ) : (
          shown.map((e) => (
            <div key={e.seq} className={`log-line ${e.level}`}>
              <span className="log-time">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className="log-sess">{e.session ? `#${e.session}` : '·'}</span>
              <span className="log-pol">{e.policy ?? ''}</span>
              <span className="log-msg">{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
