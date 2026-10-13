import { useEffect, useState } from 'react'
import { api } from './api'

export function copy(text: string) {
  void navigator.clipboard?.writeText(text)
}

export function downloadText(fileName: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName })
  a.click()
  URL.revokeObjectURL(url)
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, ms / 1000)
  if (s < 60) return `${s.toFixed(1)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Re-render every `ms` so timers tick between polls. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export interface Viewing {
  title: string
  /** Saved payload file to load, or inline content (e.g. a raw create-quote response). */
  file?: string
  content?: unknown
}

export function JsonViewer({ viewing, onClose }: { viewing: Viewing; onClose: () => void }) {
  const [text, setText] = useState<string | null>(
    viewing.file ? null : typeof viewing.content === 'string' ? viewing.content : JSON.stringify(viewing.content, null, 2),
  )
  const [error, setError] = useState('')

  useEffect(() => {
    if (!viewing.file) return
    api
      .fileText(viewing.file)
      .then((t) => {
        try {
          setText(JSON.stringify(JSON.parse(t), null, 2))
        } catch {
          setText(t)
        }
      })
      .catch((e: Error) => setError(e.message))
  }, [viewing.file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fileName = viewing.file ?? `${viewing.title.replace(/[^\w.-]+/g, '_')}.json`
  return (
    <div className="overlay" onClick={onClose}>
      <div className="viewer" role="dialog" aria-label={viewing.title} onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <h2 className="mono">{viewing.title}</h2>
          <div className="row-actions">
            <button className="ghost" disabled={text === null} onClick={() => text && copy(text)}>Copy</button>
            <button className="ghost" disabled={text === null} onClick={() => text && downloadText(fileName, text)}>
              Download
            </button>
            <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <pre className="json">{error ? `Could not load file: ${error}` : (text ?? 'Loading…')}</pre>
      </div>
    </div>
  )
}

export interface Toast {
  id: number
  tone: 'good' | 'warn' | 'bad'
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <div>
            <strong>{t.title}</strong>
            <div className="small">{t.body}</div>
          </div>
          <div className="row-actions">
            {t.action && (
              <button
                className="ghost tiny"
                onClick={() => {
                  t.action!.onClick()
                  onDismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="ghost tiny" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>✕</button>
          </div>
        </div>
      ))}
    </div>
  )
}
