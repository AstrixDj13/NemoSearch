import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, ExternalLink, Pencil, UserPlus, X } from 'lucide-react'
import { networkApi } from '../../api'
import type { Organization } from '../../network'
import { OrcidDialog, OrgDialog } from './dialogs'
import { LoadError, Loading, NetworkLink, VerifiedBadge, WorkRow } from './shared'
import type { NetworkContext } from './shared'

export default function OrgPage({ ctx, id }: { ctx: NetworkContext; id: string }) {
  const [org, setOrg] = useState<Organization | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<'edit' | 'member' | null>(null)

  const load = useCallback(() => {
    networkApi
      .org(id)
      .then((o) => {
        setError('')
        setOrg(o)
      })
      .catch((e: Error) => setError(e.message))
  }, [id])
  useEffect(load, [load])

  if (error) return <LoadError message={error} retry={load} />
  if (!org) return <Loading what="this organization" />

  const isAdmin = org.yourRole === 'admin'
  const changed = (next: Organization, message: string) => {
    setOrg(next)
    setOpen(null)
    ctx.notify(message)
    ctx.refreshMe()
  }

  return (
    <article className="net-person">
      <div className="net-work-labels">
        {org.verified ? <VerifiedBadge label="Verified organization" /> : <span className="net-badge">Not verified yet</span>}
        {org.rorId && (
          <a className="net-badge" href={`https://ror.org/${org.rorId}`} target="_blank" rel="noreferrer">
            ROR {org.rorId}
          </a>
        )}
      </div>
      <h1 className="net-work-title">{org.name}</h1>
      {org.website && (
        <p className="net-work-authors">
          <a href={org.website} target="_blank" rel="noreferrer">
            {org.website.replace(/^https?:\/\//, '')} <ExternalLink size={12} aria-hidden="true" />
          </a>
        </p>
      )}
      {org.description && <p className="net-abstract">{org.description}</p>}
      {!org.verified && (
        <p className="net-explain">
          A NemoSearch admin hasn't confirmed that this account represents {org.name}. Treat its claims accordingly.
        </p>
      )}

      {(isAdmin || ctx.me?.isAdmin) && (
        <div className="net-actions">
          {isAdmin && (
            <>
              <button type="button" onClick={() => setOpen('edit')}>
                <Pencil size={16} aria-hidden="true" /> Edit
              </button>
              <button type="button" onClick={() => setOpen('member')}>
                <UserPlus size={16} aria-hidden="true" /> Add member
              </button>
            </>
          )}
          {ctx.me?.isAdmin && (
            <button
              type="button"
              onClick={() =>
                networkApi
                  .adminVerifyOrg(org.id, !org.verified)
                  .then((o) => changed(o, o.verified ? 'Marked as verified.' : 'Verification removed.'))
                  .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
              }
            >
              <BadgeCheck size={16} aria-hidden="true" /> {org.verified ? 'Remove verification (admin)' : 'Mark verified (admin)'}
            </button>
          )}
        </div>
      )}

      <section className="net-section">
        <h2 className="section-label">Members · {org.members.length}</h2>
        <ul className="workspace-list">
          {org.members.map((m) => (
            <li key={m.id}>
              <div>
                <strong>
                  <NetworkLink ctx={ctx} route={{ page: 'person', id: m.id }}>
                    {m.name}
                  </NetworkLink>
                </strong>
                <small>
                  {m.role === 'admin' ? 'Admin' : 'Member'}
                  {m.orcid && ` · ORCID ${m.orcid}`}
                </small>
              </div>
              <span />
              {(isAdmin || m.id === ctx.me?.id) && (
                <button
                  type="button"
                  aria-label={m.id === ctx.me?.id ? 'Leave this organization' : `Remove ${m.name}`}
                  title={m.id === ctx.me?.id ? 'Leave' : 'Remove'}
                  onClick={() =>
                    networkApi
                      .removeOrgMember(org.id, m.id)
                      .then((o) => changed(o, m.id === ctx.me?.id ? `You left ${org.name}.` : `Removed ${m.name}.`))
                      .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
                  }
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="net-section">
        <h2 className="section-label">Shared works · {org.works.length}</h2>
        {org.works.length === 0 ? (
          <p className="workspace-empty">No works shared for this organization yet.</p>
        ) : (
          <ul className="net-list">
            {org.works.map((w) => (
              <WorkRow key={w.id} ctx={ctx} work={w} />
            ))}
          </ul>
        )}
      </section>

      {open === 'edit' && <OrgDialog org={org} onCancel={() => setOpen(null)} onDone={(o) => changed(o, 'Saved.')} />}
      {open === 'member' && (
        <OrcidDialog
          title={`Add someone to ${org.name}`}
          hint="They need a NemoSearch account. Members can publish works for the organization."
          submitLabel="Add"
          withRole
          onCancel={() => setOpen(null)}
          onSubmit={async (orcid, role) => changed(await networkApi.addOrgMember(org.id, orcid, role), 'Added.')}
        />
      )}
    </article>
  )
}
