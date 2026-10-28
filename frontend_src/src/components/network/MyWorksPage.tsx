import { useCallback, useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import { networkApi } from '../../api'
import type { WorkSummary } from '../../network'
import { ClaimDialog } from './dialogs'
import { LoadError, Loading, WorkRow } from './shared'
import type { NetworkContext } from './shared'

// Everything you published (including private works), and works others shared with you
export default function MyWorksPage({ ctx }: { ctx: NetworkContext }) {
  const [mine, setMine] = useState<WorkSummary[] | null>(null)
  const [shared, setShared] = useState<WorkSummary[]>([])
  const [error, setError] = useState('')
  const [claiming, setClaiming] = useState(false)

  const load = useCallback(() => {
    Promise.all([networkApi.mine(), networkApi.shared()])
      .then(([m, s]) => {
        setError('')
        setMine(m)
        setShared(s)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(load, [load])

  if (error) return <LoadError message={`Couldn't load your works: ${error}`} retry={load} />
  if (!mine) return <Loading what="your works" />

  return (
    <>
      <section className="net-section" aria-labelledby="mine-title">
        <div className="workspace-heading">
          <h2 id="mine-title" className="section-label">
            Your works · {mine.length}
          </h2>
          <button type="button" className="text-link" onClick={() => setClaiming(true)}>
            <Link2 size={14} aria-hidden="true" /> Claim a published paper
          </button>
        </div>
        {mine.length === 0 ? (
          <p className="workspace-empty">
            Nothing yet. Publish a PDF or one of your reports; it stays private until you choose to share it.
          </p>
        ) : (
          <ul className="net-list">
            {mine.map((w) => (
              <WorkRow key={w.id} ctx={ctx} work={w} showOwner={false} />
            ))}
          </ul>
        )}
      </section>
      <section className="net-section" aria-labelledby="shared-title">
        <h2 id="shared-title" className="section-label">
          Shared with you · {shared.length}
        </h2>
        {shared.length === 0 ? (
          <p className="workspace-empty">Works other researchers invite you to, or approve your requests for, appear here.</p>
        ) : (
          <ul className="net-list">
            {shared.map((w) => (
              <WorkRow key={w.id} ctx={ctx} work={w} />
            ))}
          </ul>
        )}
      </section>
      {claiming && (
        <ClaimDialog
          onCancel={() => setClaiming(false)}
          onDone={(w) => {
            setClaiming(false)
            ctx.notify(`Claimed “${w.title}”. It's on your profile and links to the original.`)
            ctx.navigate({ page: 'work', id: w.id })
          }}
        />
      )}
    </>
  )
}
