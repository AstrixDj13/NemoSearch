import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle } from 'lucide-react'
import { api } from '../api'
import type { ProjectMessage } from '../data'

interface ProjectThreadProps {
  projectId: string
  /** People the project is shared with (the owner not counted); with none, only the owner can read the thread */
  memberCount: number
  /** Free-text notes written before projects had a discussion; shown read-only so nothing is lost */
  legacyNotes: string
}

const MAX_CHARS = 4000
// New messages from collaborators are fetched this often while the page is visible
const POLL_MS = 8000

const formatTime = (ms: number) => {
  const date = new Date(ms)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const merge = (prev: ProjectMessage[], next: ProjectMessage[]) => {
  const seen = new Set(prev.map((m) => m.id))
  const added = next.filter((m) => !seen.has(m.id))
  return added.length ? [...prev, ...added].sort((a, b) => a.createdAt - b.createdAt) : prev
}

// The project's discussion: a plain-text message thread between the owner and the people it is shared with
export default function ProjectThread({ projectId, memberCount, legacyNotes }: ProjectThreadProps) {
  const [messages, setMessages] = useState<ProjectMessage[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Follow new messages only while the reader is at the bottom, so reading older ones is not interrupted
  const stickToBottom = useRef(true)
  const lastAt = messages.length ? messages[messages.length - 1].createdAt : undefined
  const lastAtRef = useRef(lastAt)
  lastAtRef.current = lastAt

  useEffect(() => {
    let cancelled = false
    api
      .listMessages(projectId)
      .then((list) => {
        if (cancelled) return
        setMessages(list)
        setStatus('ready')
      })
      .catch(() => !cancelled && setStatus('error'))
    return () => {
      cancelled = true
    }
  }, [projectId])

  const fetchNew = useCallback(() => {
    if (document.visibilityState !== 'visible') return
    api
      .listMessages(projectId, lastAtRef.current)
      .then((list) => setMessages((prev) => merge(prev, list)))
      .catch(() => {}) // a missed poll is retried on the next one
  }, [projectId])

  useEffect(() => {
    if (status !== 'ready') return
    const timer = window.setInterval(fetchNew, POLL_MS)
    document.addEventListener('visibilitychange', fetchNew)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', fetchNew)
    }
  }, [status, fetchNew])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [messages])

  // The composer grows with its text, up to six lines
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }, [draft])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending || body.length > MAX_CHARS) return
    setSending(true)
    setSendError('')
    try {
      const message = await api.postMessage(projectId, body)
      stickToBottom.current = true
      setMessages((prev) => merge(prev, [message]))
      setDraft('')
    } catch (e) {
      setSendError((e as Error).message)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const over = draft.trim().length - MAX_CHARS
  const audience = memberCount ? `Visible to ${memberCount + 1} people` : 'Only you can see this'

  return (
    <section className="workspace-section" aria-labelledby="ws-discussion">
      <div className="workspace-heading">
        <h2 id="ws-discussion" className="section-label">
          Discussion
        </h2>
        <span className="workspace-status">{audience}</span>
      </div>

      {legacyNotes.trim() && (
        <div className="thread-legacy">
          <div className="thread-legacy-label">Earlier notes</div>
          <p>{legacyNotes}</p>
        </div>
      )}

      <div className="thread">
        <div
          ref={listRef}
          className="thread-messages"
          role="log"
          aria-label="Project discussion"
          tabIndex={0}
          onScroll={(event) => {
            const el = event.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {status === 'loading' && <p className="thread-empty">Loading messages…</p>}
          {status === 'error' && (
            <p className="thread-empty" role="alert">
              Couldn't load the discussion. Reload the page to try again.
            </p>
          )}
          {status === 'ready' && messages.length === 0 && (
            <p className="thread-empty">
              {memberCount
                ? 'No messages yet. Start the discussion with your collaborators.'
                : 'No messages yet. Share the project below to discuss it with collaborators.'}
            </p>
          )}
          {messages.length > 0 && (
            <ol className="thread-list">
              {messages.map((m, i) => {
                const prev = messages[i - 1]
                // Consecutive messages from one person within five minutes share one name line
                const grouped = prev && prev.author?.id === m.author?.id && m.createdAt - prev.createdAt < 5 * 60 * 1000
                const name = m.mine ? 'You' : m.author?.name || 'Former member'
                return (
                  <li key={m.id} className={`thread-message ${m.mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`}>
                    <div className={grouped ? 'visually-hidden' : 'thread-meta'}>
                      <span className="thread-author">{name}</span>{' '}
                      <time dateTime={new Date(m.createdAt).toISOString()}>{formatTime(m.createdAt)}</time>
                    </div>
                    <p className="thread-bubble">{m.body}</p>
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        <form
          className="thread-composer"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <label className="visually-hidden" htmlFor="thread-input">
            Message to the project
          </label>
          <textarea
            id="thread-input"
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter starts a new line; never while an input method is composing text
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            }}
            placeholder="Message your collaborators…"
            aria-describedby={over > 0 ? 'thread-hint' : undefined}
            aria-invalid={over > 0 || undefined}
            disabled={status !== 'ready'}
          />
          <button type="submit" className="thread-send" aria-label="Send message" title="Send" disabled={!draft.trim() || sending || over > 0}>
            {sending ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
          </button>
        </form>
        {over > 0 && (
          <p className="thread-hint" id="thread-hint">
            <span className="thread-over">
              {over} characters over the {MAX_CHARS}-character limit.
            </span>
          </p>
        )}
        {sendError && (
          <p className="thread-error" role="alert">
            Couldn't send: {sendError} Your message is still in the box.
          </p>
        )}
      </div>
    </section>
  )
}
