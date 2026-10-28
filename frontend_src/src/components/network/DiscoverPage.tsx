import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { networkApi } from '../../api'
import type { PublicUser, WorkSummary } from '../../network'
import { LoadError, NetworkLink, WorkRow } from './shared'
import type { NetworkContext } from './shared'

// Search works people chose to share (Open or Request access), and researchers by name or interest.
// No feed and no ranking by popularity: results are matches, newest first.
export default function DiscoverPage({ ctx }: { ctx: NetworkContext }) {
  const [mode, setMode] = useState<'works' | 'people'>('works')
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [tag, setTag] = useState('')
  const [works, setWorks] = useState<WorkSummary[]>([])
  const [total, setTotal] = useState(0)
  const [people, setPeople] = useState<PublicUser[]>([])
  // Which search the shown results answer; while it differs from the current one, a search is in flight
  const key = `${mode}|${submitted}|${tag}`
  const [loadedKey, setLoadedKey] = useState('')
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const status = failure?.key === key ? 'error' : loadedKey === key ? 'ready' : 'loading'
  const error = failure?.message ?? ''

  useEffect(() => {
    let cancelled = false
    const load =
      mode === 'works'
        ? networkApi.discover(submitted, tag).then((r) => {
            if (cancelled) return
            setWorks(r.items)
            setTotal(r.total)
          })
        : submitted
          ? networkApi.people(submitted).then((r) => !cancelled && setPeople(r))
          : Promise.resolve().then(() => !cancelled && setPeople([]))
    load
      .then(() => !cancelled && setLoadedKey(key))
      .catch((e: Error) => !cancelled && setFailure({ key, message: e.message }))
    return () => {
      cancelled = true
    }
  }, [key, mode, submitted, tag])

  const loadMore = () =>
    networkApi
      .discover(submitted, tag, works.length)
      .then((r) => setWorks((prev) => [...prev, ...r.items]))
      .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))

  return (
    <section aria-label="Discover">
      <form
        className="library-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(query.trim())
        }}
      >
        <div className="segmented" role="group" aria-label="Search for">
          <button type="button" aria-pressed={mode === 'works'} onClick={() => setMode('works')}>
            Works
          </button>
          <button type="button" aria-pressed={mode === 'people'} onClick={() => setMode('people')} disabled={!ctx.me}>
            Researchers
          </button>
        </div>
        <div className="library-search">
          <Search size={18} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === 'works' ? 'Search titles, abstracts, authors and tags…' : 'Search by name, affiliation, interest or ORCID iD…'}
            aria-label={mode === 'works' ? 'Search works' : 'Search researchers'}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setSubmitted('')
              }}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </form>

      {tag && (
        <p className="net-filter">
          Tagged <strong>{tag}</strong>{' '}
          <button type="button" className="text-link" onClick={() => setTag('')}>
            Clear
          </button>
        </p>
      )}

      {status === 'error' ? (
        <LoadError message={`Couldn't search the Network: ${error}`} />
      ) : mode === 'works' ? (
        <>
          <p className="net-count" role="status">
            {status === 'loading' ? 'Searching…' : `${total} ${total === 1 ? 'work' : 'works'}${submitted ? ` matching “${submitted}”` : ''}`}
          </p>
          {status === 'ready' && works.length === 0 ? (
            <p className="workspace-empty">
              {submitted || tag
                ? 'Nothing matches yet. Try fewer or broader words.'
                : 'Nothing is shared yet. Works appear here when their owners make them Open or Request access.'}
            </p>
          ) : (
            <ul className="net-list">
              {works.map((w) => (
                <WorkRow key={w.id} ctx={ctx} work={w} />
              ))}
            </ul>
          )}
          {works.length < total && (
            <button type="button" className="secondary-button net-more" onClick={loadMore}>
              Show more
            </button>
          )}
          {works.some((w) => w.tags.length) && !tag && (
            <div className="net-tag-cloud" aria-label="Filter by tag">
              {[...new Set(works.flatMap((w) => w.tags))].slice(0, 16).map((t) => (
                <button key={t} type="button" onClick={() => setTag(t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
        </>
      ) : !submitted ? (
        <p className="workspace-empty">Search for researchers by name, affiliation, research interest or ORCID iD.</p>
      ) : status === 'ready' && people.length === 0 ? (
        <p className="workspace-empty">No researchers match “{submitted}”.</p>
      ) : (
        <ul className="net-list">
          {people.map((p) => (
            <li key={p.id} className="net-row">
              <div className="net-row-main">
                <NetworkLink ctx={ctx} route={{ page: 'person', id: p.id }} className="net-row-title">
                  {p.name}
                </NetworkLink>
                <small>
                  {[p.affiliation, p.orcid && `ORCID ${p.orcid}`].filter(Boolean).join(' · ')}
                </small>
                {p.interests.length > 0 && (
                  <span className="net-tags">
                    {p.interests.slice(0, 5).map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
