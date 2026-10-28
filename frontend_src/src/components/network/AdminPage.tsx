import { useCallback, useEffect, useState } from 'react'
import { networkApi } from '../../api'
import { formatDate } from '../../network'
import type { AbuseReport } from '../../network'
import { LoadError, Loading, NetworkLink } from './shared'
import type { NetworkContext } from './shared'

// Reports from researchers, for site admins. Takedowns happen on the work page itself.
export default function AdminPage({ ctx }: { ctx: NetworkContext }) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open')
  const [reports, setReports] = useState<AbuseReport[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    networkApi
      .adminAbuse(status)
      .then((r) => {
        setError('')
        setReports(r)
      })
      .catch((e: Error) => setError(e.message))
  }, [status])
  useEffect(load, [load])

  return (
    <section className="net-section">
      <div className="workspace-heading">
        <h2 className="section-label">Reports</h2>
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            Open
          </button>
          <button type="button" aria-pressed={status === 'resolved'} onClick={() => setStatus('resolved')}>
            Resolved
          </button>
        </div>
      </div>
      {error ? (
        <LoadError message={error} retry={load} />
      ) : !reports ? (
        <Loading what="reports" />
      ) : reports.length === 0 ? (
        <p className="workspace-empty">{status === 'open' ? 'No open reports.' : 'Nothing resolved yet.'}</p>
      ) : (
        <ul className="net-requests">
          {reports.map((r) => (
            <li key={r.id} className="net-request">
              <div className="net-request-head">
                <strong>
                  {r.reason} ·{' '}
                  <NetworkLink ctx={ctx} route={r.targetKind === 'work' ? { page: 'work', id: r.targetId } : { page: 'person', id: r.targetId }}>
                    {r.targetTitle}
                  </NetworkLink>
                </strong>
                <small>
                  {r.targetKind === 'work' ? 'Work' : 'Researcher'} · {formatDate(r.createdAt)}
                </small>
              </div>
              {r.details && <blockquote className="net-message">{r.details}</blockquote>}
              {r.status === 'resolved' ? (
                <p className="net-response">
                  <span className="section-label">Resolution</span> {r.resolution || '—'}
                </p>
              ) : (
                <form
                  className="net-resolve"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const resolution = String(new FormData(event.currentTarget).get('resolution') || '')
                    networkApi
                      .adminResolve(r.id, resolution)
                      .then(load)
                      .then(() => ctx.notify('Marked as resolved.'))
                      .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
                  }}
                >
                  <label className="visually-hidden" htmlFor={`res-${r.id}`}>
                    Resolution
                  </label>
                  <input id={`res-${r.id}`} name="resolution" placeholder="What you did (e.g. taken down, no action)" />
                  <button type="submit" className="secondary-button">
                    Resolve
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
