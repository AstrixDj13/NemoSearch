import { useCallback, useEffect, useState } from 'react'
import { Ban, Building2, Download, Flag, Lock, Plus, Trash2 } from 'lucide-react'
import { api, networkApi } from '../../api'
import { orcidUrl } from '../../network'
import type { Me, Person } from '../../network'
import { AbuseDialog, ConfirmDialog, OrgDialog } from './dialogs'
import { LoadError, Loading, NetworkLink, VerifiedBadge, WorkRow } from './shared'
import type { NetworkContext } from './shared'

// A researcher's public page: who they are and what they chose to share. No follower counts, no activity feed.
export function PersonPage({ ctx, id }: { ctx: NetworkContext; id: string }) {
  const [person, setPerson] = useState<Person | null>(null)
  const [error, setError] = useState('')
  const [reporting, setReporting] = useState(false)

  const load = useCallback(() => {
    networkApi
      .person(id)
      .then((p) => {
        setError('')
        setPerson(p)
      })
      .catch((e: Error) => setError(e.message))
  }, [id])
  useEffect(load, [load])

  if (error) return <LoadError message={error} retry={load} />
  if (!person) return <Loading what="this profile" />

  return (
    <article className="net-person">
      <div className="net-work-labels">
        {person.orcid && (
          <a className="net-badge verified" href={orcidUrl(person.orcid, ctx.orcidBase)} target="_blank" rel="noreferrer" title="Signed in with this ORCID iD">
            ORCID {person.orcid}
          </a>
        )}
      </div>
      <h1 className="net-work-title">{person.name}</h1>
      {person.affiliation && <p className="net-work-authors">{person.affiliation}</p>}
      {person.bio && <p className="net-abstract">{person.bio}</p>}
      {person.interests.length > 0 && (
        <p className="net-tags large">
          {person.interests.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </p>
      )}
      {person.organizations.length > 0 && (
        <p className="net-orgs">
          {person.organizations.map((o) => (
            <NetworkLink key={o.id} ctx={ctx} route={{ page: 'org', id: o.id }} className="net-org-link">
              <Building2 size={13} aria-hidden="true" /> {o.name} {o.verified && <VerifiedBadge />}
            </NetworkLink>
          ))}
        </p>
      )}
      {!person.isYou && ctx.me && (
        <div className="net-actions">
          <button
            type="button"
            onClick={() =>
              networkApi
                .block(person.id, !person.blockedByYou)
                .then(load)
                .then(() => ctx.notify(person.blockedByYou ? `Unblocked ${person.name}.` : `Blocked ${person.name}. They can't send you requests.`))
                .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
            }
          >
            <Ban size={16} aria-hidden="true" /> {person.blockedByYou ? 'Unblock' : 'Block'}
          </button>
          <button type="button" onClick={() => setReporting(true)}>
            <Flag size={16} aria-hidden="true" /> Report
          </button>
        </div>
      )}
      {person.isYou && (
        <div className="net-actions">
          <button type="button" onClick={() => ctx.navigate({ page: 'profile' })}>
            Edit your profile
          </button>
        </div>
      )}
      <section className="net-section">
        <h2 className="section-label">{person.isYou ? 'Your works (only you see private ones)' : 'Shared works'} · {person.works.length}</h2>
        {person.works.length === 0 ? (
          <p className="workspace-empty">{person.isYou ? 'Nothing published yet.' : `${person.name} hasn't shared any works yet.`}</p>
        ) : (
          <ul className="net-list">
            {person.works.map((w) => (
              <WorkRow key={w.id} ctx={ctx} work={w} showOwner={false} />
            ))}
          </ul>
        )}
      </section>
      {reporting && (
        <AbuseDialog
          targetKind="user"
          targetId={person.id}
          onCancel={() => setReporting(false)}
          onDone={() => {
            setReporting(false)
            ctx.notify('Thanks. The report went to the NemoSearch admins.')
          }}
        />
      )}
    </article>
  )
}

// Your own profile: what others see, your private notification email, organizations, and your data
export function ProfilePage({ ctx, me }: { ctx: NetworkContext; me: Me }) {
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const [creatingOrg, setCreatingOrg] = useState(false)
  const [deleting, setDeleting] = useState(false)

  return (
    <>
      <form
        className="net-profile-form"
        onSubmit={async (event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          setSaving('saving')
          setError('')
          try {
            await api.updateMe({
              name: String(data.get('name') || ''),
              affiliation: String(data.get('affiliation') || ''),
              bio: String(data.get('bio') || ''),
              interests: String(data.get('interests') || '').split(',').map((s) => s.trim()).filter(Boolean),
              notifyEmail: String(data.get('notifyEmail') || ''),
            })
            setSaving('saved')
            ctx.refreshMe()
          } catch (e) {
            setError((e as Error).message)
            setSaving('idle')
          }
        }}
      >
        <section className="net-section">
          <div className="workspace-heading">
            <h2 className="section-label">Public profile</h2>
            <NetworkLink ctx={ctx} route={{ page: 'person', id: me.id }} className="text-link">
              See how others see it
            </NetworkLink>
          </div>
          <p className="net-explain">
            Signed in as ORCID iD{' '}
            <a href={orcidUrl(me.orcid ?? '', ctx.orcidBase)} target="_blank" rel="noreferrer">
              {me.orcid}
            </a>
            . Affiliation and interests are what you enter here; they are not checked.
          </p>
          <div className="net-form-grid">
            <label className="field">
              <span>Name</span>
              <input name="name" defaultValue={me.name} maxLength={200} />
            </label>
            <label className="field">
              <span>Affiliation</span>
              <input name="affiliation" defaultValue={me.affiliation} maxLength={300} placeholder="e.g. University College Dublin" />
            </label>
          </div>
          <label className="field">
            <span>About</span>
            <textarea name="bio" defaultValue={me.bio} rows={3} maxLength={2000} />
          </label>
          <label className="field">
            <span>
              Research interests <small>(comma-separated; people can find you by them)</small>
            </span>
            <input name="interests" defaultValue={me.interests.join(', ')} />
          </label>
        </section>
        <section className="net-section">
          <h2 className="section-label">
            <Lock size={12} aria-hidden="true" /> Notifications
          </h2>
          <label className="field">
            <span>
              Email for notifications <small>(optional; never shown to anyone)</small>
            </span>
            <input name="notifyEmail" type="email" defaultValue={me.notifyEmail} placeholder="you@example.org" />
          </label>
          <p className="net-explain">Emails say only that something happened; request messages stay in NemoSearch.</p>
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="net-form-actions">
          <button type="submit" className="primary-button" disabled={saving === 'saving'}>
            {saving === 'saving' ? 'Saving…' : 'Save profile'}
          </button>
          <span role="status" className="workspace-status">
            {saving === 'saved' && 'Saved'}
          </span>
        </div>
      </form>

      <section className="net-section">
        <div className="workspace-heading">
          <h2 className="section-label">Organizations · {me.organizations.length}</h2>
          <button type="button" className="text-link" onClick={() => setCreatingOrg(true)}>
            <Plus size={14} aria-hidden="true" /> New organization
          </button>
        </div>
        {me.organizations.length === 0 ? (
          <p className="workspace-empty">Create one for your lab or company, or ask an admin of an existing one to add you.</p>
        ) : (
          <ul className="workspace-list">
            {me.organizations.map((o) => (
              <li key={o.id}>
                <div>
                  <strong>
                    <NetworkLink ctx={ctx} route={{ page: 'org', id: o.id }}>
                      {o.name}
                    </NetworkLink>
                    {o.verified && <VerifiedBadge />}
                  </strong>
                  <small>{o.role === 'admin' ? 'Admin' : 'Member'}</small>
                </div>
                <span />
                <span />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="net-section">
        <h2 className="section-label">Your data</h2>
        <div className="net-actions">
          <a href="/api/me/export" download>
            <Download size={16} aria-hidden="true" /> Download everything (JSON)
          </a>
          <button type="button" className="danger-outline" onClick={() => setDeleting(true)}>
            <Trash2 size={16} aria-hidden="true" /> Delete account
          </button>
        </div>
      </section>

      {creatingOrg && (
        <OrgDialog
          onCancel={() => setCreatingOrg(false)}
          onDone={(o) => {
            setCreatingOrg(false)
            ctx.refreshMe()
            ctx.navigate({ page: 'org', id: o.id })
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete your account?"
          body="This permanently deletes your research, projects, files and published works. Research that collaborators added to your projects moves to their own Library. Ownership log entries stay, holding only your ORCID iD and an account id. This can't be undone."
          confirmLabel="Delete my account"
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteAccount()
            window.location.assign('/')
          }}
        />
      )}
    </>
  )
}
