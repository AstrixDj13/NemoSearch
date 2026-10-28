import { useCallback, useEffect, useState } from 'react'
import { Check, FolderOpen, X } from 'lucide-react'
import { networkApi } from '../../api'
import { formatDate } from '../../network'
import type { NetworkNotification, NetworkRequest } from '../../network'
import { DecisionDialog } from './dialogs'
import { LoadError, Loading, NetworkLink } from './shared'
import type { NetworkContext } from './shared'

const STATUS: Record<NetworkRequest['status'], string> = {
  pending: 'Waiting for a reply',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

function describe(n: NetworkNotification): string {
  const title = n.data.work_title || n.data.project_name || ''
  switch (n.kind) {
    case 'request_received':
      return `${n.data.from ?? 'Someone'} ${n.data.kind === 'collaborate' ? 'proposed a collaboration on' : 'asked to read'} “${title}”.`
    case 'request_accepted':
      return n.data.kind === 'collaborate' ? `Your collaboration request for “${title}” was accepted. A shared project is in your Library.` : `You can now read “${title}”.`
    case 'request_declined':
      return `Your request for “${title}” was declined.`
    case 'project_shared':
      return `A project was shared with you: “${title}”.`
    case 'access_granted':
      return `You were invited to read “${title}”.`
    case 'work_taken_down':
      return `“${title}” was taken down by an admin${n.data.reason ? `: ${n.data.reason}` : '.'}`
    default:
      return title || 'Update'
  }
}

export default function RequestsPage({ ctx }: { ctx: NetworkContext }) {
  const [incoming, setIncoming] = useState<NetworkRequest[] | null>(null)
  const [outgoing, setOutgoing] = useState<NetworkRequest[]>([])
  const [notes, setNotes] = useState<NetworkNotification[]>([])
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState<{ request: NetworkRequest; accept: boolean } | null>(null)
  const { refreshMe } = ctx

  const load = useCallback(() => {
    Promise.all([networkApi.requests('incoming'), networkApi.requests('outgoing'), networkApi.notifications()])
      .then(([i, o, n]) => {
        setError('')
        setIncoming(i)
        setOutgoing(o)
        setNotes(n)
        // Seeing them here counts as reading them
        if (n.some((x) => !x.read)) networkApi.markRead().then(refreshMe, () => undefined)
      })
      .catch((e: Error) => setError(e.message))
  }, [refreshMe])

  useEffect(load, [load])

  if (error) return <LoadError message={`Couldn't load requests: ${error}`} retry={load} />
  if (!incoming) return <Loading what="requests" />

  const pending = incoming.filter((r) => r.status === 'pending')
  const answered = incoming.filter((r) => r.status !== 'pending')

  const requestItem = (r: NetworkRequest) => (
    <li key={r.id} className="net-request">
      <div className="net-request-head">
        <strong>
          {r.incoming && r.requester ? (
            <NetworkLink ctx={ctx} route={{ page: 'person', id: r.requester.id }}>
              {r.requester.name}
            </NetworkLink>
          ) : (
            'You'
          )}{' '}
          {r.kind === 'collaborate' ? 'proposed a collaboration on' : 'asked to read'}{' '}
          {r.work ? (
            <NetworkLink ctx={ctx} route={{ page: 'work', id: r.work.id }}>
              {r.work.title}
            </NetworkLink>
          ) : (
            'a deleted work'
          )}
        </strong>
        <small>
          {r.incoming && r.requester && [r.requester.affiliation, r.requester.orcid && `ORCID ${r.requester.orcid}`].filter(Boolean).join(' · ')}
          {r.incoming && r.requester && ' · '}
          {formatDate(r.createdAt)} · {STATUS[r.status]}
        </small>
      </div>
      {r.message && <blockquote className="net-message">{r.message}</blockquote>}
      {r.response && (
        <p className="net-response">
          <span className="section-label">Reply</span> {r.response}
        </p>
      )}
      <div className="net-request-actions">
        {r.incoming && r.status === 'pending' && (
          <>
            <button type="button" className="primary-button" onClick={() => setDeciding({ request: r, accept: true })}>
              <Check size={15} aria-hidden="true" /> Accept
            </button>
            <button type="button" className="secondary-button" onClick={() => setDeciding({ request: r, accept: false })}>
              <X size={15} aria-hidden="true" /> Decline
            </button>
          </>
        )}
        {!r.incoming && r.status === 'pending' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              networkApi
                .withdraw(r.id)
                .then(load)
                .then(() => ctx.notify('Request withdrawn.'))
                .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
            }
          >
            Withdraw
          </button>
        )}
        {r.status === 'accepted' && r.projectId && (
          <button type="button" className="secondary-button" onClick={() => ctx.openProject(r.projectId!)}>
            <FolderOpen size={15} aria-hidden="true" /> Open shared project
          </button>
        )}
      </div>
    </li>
  )

  return (
    <>
      <section className="net-section" aria-labelledby="req-in">
        <h2 id="req-in" className="section-label">
          Waiting for you · {pending.length}
        </h2>
        {pending.length === 0 ? (
          <p className="workspace-empty">No requests waiting. People can ask to read works set to Request access, or propose a collaboration.</p>
        ) : (
          <ul className="net-requests">{pending.map(requestItem)}</ul>
        )}
      </section>
      <section className="net-section" aria-labelledby="req-out">
        <h2 id="req-out" className="section-label">
          Sent by you · {outgoing.length}
        </h2>
        {outgoing.length === 0 ? <p className="workspace-empty">Requests you send appear here with their answers.</p> : <ul className="net-requests">{outgoing.map(requestItem)}</ul>}
      </section>
      {answered.length > 0 && (
        <section className="net-section" aria-labelledby="req-done">
          <h2 id="req-done" className="section-label">
            Answered · {answered.length}
          </h2>
          <ul className="net-requests">{answered.map(requestItem)}</ul>
        </section>
      )}
      <section className="net-section" aria-labelledby="req-notes">
        <h2 id="req-notes" className="section-label">
          Notifications
        </h2>
        {notes.length === 0 ? (
          <p className="workspace-empty">Nothing yet.</p>
        ) : (
          <ul className="workspace-list">
            {notes.map((n) => (
              <li key={n.id} className={n.read ? '' : 'unread'}>
                <div>
                  <strong className="wrap">{describe(n)}</strong>
                  <small>{formatDate(n.createdAt)}</small>
                </div>
                {n.data.work_id && n.kind !== 'work_taken_down' ? (
                  <NetworkLink ctx={ctx} route={{ page: 'work', id: n.data.work_id }} className="text-link">
                    Open
                  </NetworkLink>
                ) : n.data.project_id ? (
                  <button type="button" className="text-link" onClick={() => ctx.openProject(n.data.project_id!)}>
                    Open
                  </button>
                ) : (
                  <span />
                )}
                <span />
              </li>
            ))}
          </ul>
        )}
      </section>
      {deciding && (
        <DecisionDialog
          request={deciding.request}
          accept={deciding.accept}
          projects={ctx.projects}
          onCancel={() => setDeciding(null)}
          onDone={(r) => {
            setDeciding(null)
            ctx.notify(r.status === 'accepted' ? (r.projectId ? 'Accepted. The shared project is in your Library.' : 'Accepted. They can now read the work.') : 'Declined.')
            ctx.refreshMe()
            load()
          }}
        />
      )}
    </>
  )
}
