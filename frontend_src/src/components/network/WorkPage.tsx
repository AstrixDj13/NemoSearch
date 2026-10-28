import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Copy, Download, ExternalLink, Flag, Pencil, Send, ShieldCheck, ShieldOff, Trash2, Upload, UserPlus, X,
} from 'lucide-react'
import { networkApi } from '../../api'
import { VISIBILITY, formatDate, formatDateTime, formatSize, orcidUrl } from '../../network'
import type { WorkDetail } from '../../network'
import { AbuseDialog, ConfirmDialog, EditWorkDialog, OrcidDialog, RequestDialog, TakedownDialog, VisibilityDialog } from './dialogs'
import { LoadError, Loading, NetworkLink, VerifiedBadge, VisibilityBadge } from './shared'
import type { NetworkContext } from './shared'

type Open = 'visibility' | 'edit' | 'invite' | 'delete' | 'request' | 'abuse' | 'takedown' | null

const short = (hash: string) => `${hash.slice(0, 12)}…${hash.slice(-6)}`

export default function WorkPage({ ctx, id }: { ctx: NetworkContext; id: string }) {
  const [work, setWork] = useState<WorkDetail | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Open>(null)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    networkApi
      .work(id)
      .then((w) => {
        setError('')
        setWork(w)
      })
      .catch((e: Error) => setError(e.message))
  }, [id])

  // The page is keyed by work id, so it starts empty for each work
  useEffect(load, [load])

  if (error) return <LoadError message={error} retry={load} />
  if (!work) return <Loading what="this work" />

  const { viewer } = work
  const owner = viewer.isOwner
  const close = () => setOpen(null)
  const updated = (next: WorkDetail, message: string) => {
    setWork(next)
    close()
    ctx.notify(message)
  }

  const uploadVersion = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setUploading(true)
    try {
      updated(await networkApi.uploadVersion(work.id, file), `Uploaded “${file.name}” as a new version.`)
    } catch (e) {
      ctx.notify(`Couldn't upload “${file.name}”: ${(e as Error).message}`, undefined, 'error')
    }
    setUploading(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(
      () => ctx.notify(`${what} copied.`),
      () => ctx.notify(`Copy the ${what.toLowerCase()} from the page.`)
    )

  const pendingKinds = new Set(viewer.pendingRequests.map((p) => p.kind))
  const canAskAccess = work.visibility === 'request' && !viewer.canDownload && !pendingKinds.has('access')
  const canAskCollaboration = !pendingKinds.has('collaborate')
  const canRequest =
    !owner && !!ctx.me && !work.takenDown && (work.visibility !== 'private' || viewer.access === 'granted') && (canAskAccess || canAskCollaboration)

  return (
    <article className="net-work">
      <div className="net-work-labels">
        <VisibilityBadge work={work} />
        <span className="net-license">{work.license.label}</span>
        {work.org && (
          <NetworkLink ctx={ctx} route={{ page: 'org', id: work.org.id }} className="net-org-link">
            {work.org.name}
          </NetworkLink>
        )}
        {work.org?.verified && <VerifiedBadge label="Verified organization" />}
      </div>
      <h1 className="net-work-title">{work.title}</h1>
      <p className="net-work-authors">{work.authors.join(', ')}</p>
      {work.owner && (
        <p className="net-work-owner">
          {work.claimed ? 'Claimed by ' : 'Shared by '}
          <NetworkLink ctx={ctx} route={{ page: 'person', id: work.owner.id }}>
            {work.owner.name}
          </NetworkLink>
          {work.owner.orcid && (
            <>
              {' · '}
              <a href={orcidUrl(work.owner.orcid, ctx.orcidBase)} target="_blank" rel="noreferrer">
                ORCID {work.owner.orcid}
              </a>
            </>
          )}
          {' · '}
          {formatDate(work.createdAt)}
        </p>
      )}

      {work.takenDown && (
        <div className="net-banner" role="alert">
          <ShieldOff size={16} aria-hidden="true" />
          <div>
            <strong>This work was taken down by a NemoSearch admin.</strong>
            <p>{work.takedownReason || 'No reason was given.'} Only its owner and admins can see it.</p>
          </div>
        </div>
      )}

      <div className="net-actions">
        {owner && (
          <>
            <button type="button" onClick={() => setOpen('visibility')}>
              <ShieldCheck size={16} aria-hidden="true" /> Visibility: {VISIBILITY[work.visibility].label}
            </button>
            {!work.claimed && (
              <>
                <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="visually-hidden" tabIndex={-1} onChange={(e) => uploadVersion(e.target.files)} />
                <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-busy={uploading}>
                  <Upload size={16} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Upload new version'}
                </button>
              </>
            )}
            <button type="button" onClick={() => setOpen('edit')}>
              <Pencil size={16} aria-hidden="true" /> Edit details
            </button>
            {work.visibility !== 'open' && (
              <button type="button" onClick={() => setOpen('invite')}>
                <UserPlus size={16} aria-hidden="true" /> Invite by ORCID iD
              </button>
            )}
            <button type="button" onClick={() => setOpen('delete')}>
              <Trash2 size={16} aria-hidden="true" /> Delete
            </button>
          </>
        )}
        {canRequest && (
          <button type="button" className="net-primary-action" onClick={() => setOpen('request')}>
            <Send size={16} aria-hidden="true" /> {canAskAccess ? 'Request access' : 'Propose collaboration'}
          </button>
        )}
        {!owner && pendingKinds.size > 0 && <span className="net-pending">Request sent · waiting for a reply</span>}
        {!ctx.me && (
          <a className="net-primary-action" href={`/api/auth/orcid/login?next=${encodeURIComponent(window.location.pathname)}`}>
            <Send size={16} aria-hidden="true" /> Sign in with ORCID to {work.visibility === 'request' ? 'request access' : 'collaborate'}
          </a>
        )}
        {work.claimed && work.externalUrl && (
          <a href={work.externalUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} aria-hidden="true" /> Read the original
          </a>
        )}
        {!owner && ctx.me && (
          <button type="button" onClick={() => setOpen('abuse')}>
            <Flag size={16} aria-hidden="true" /> Report
          </button>
        )}
        {ctx.me?.isAdmin && !owner && (
          work.takenDown ? (
            <button
              type="button"
              onClick={() =>
                networkApi
                  .adminTakedown(work.id, false, '')
                  .then((w) => updated(w, 'Restored the work.'))
                  .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
              }
            >
              <ShieldCheck size={16} aria-hidden="true" /> Restore (admin)
            </button>
          ) : (
            <button type="button" onClick={() => setOpen('takedown')}>
              <ShieldOff size={16} aria-hidden="true" /> Take down (admin)
            </button>
          )
        )}
      </div>

      {work.abstract && (
        <section className="net-section">
          <h2 className="section-label">Abstract</h2>
          <p className="net-abstract">{work.abstract}</p>
        </section>
      )}

      {work.tags.length > 0 && (
        <p className="net-tags large">
          {work.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </p>
      )}

      {work.claimed ? (
        <section className="net-section">
          <h2 className="section-label">Authorship check</h2>
          <p className="net-explain">
            {work.claimEvidence ?? "OpenAlex lists the claimant's ORCID iD among the authors."} DOI{' '}
            <a href={`https://doi.org/${work.doi}`} target="_blank" rel="noreferrer">
              {work.doi}
            </a>
            . NemoSearch links to the original publication and hosts no copy.
          </p>
        </section>
      ) : (
        <section className="net-section">
          <h2 className="section-label">Files · {work.versions.length}</h2>
          {work.versions.length === 0 ? (
            <p className="workspace-empty">{owner ? 'Upload a PDF before you share this work.' : 'No file has been uploaded yet.'}</p>
          ) : !viewer.canDownload ? (
            <p className="workspace-empty">
              The file is shared only with people {work.owner?.name ?? 'the owner'} approves.
              {viewer.pendingRequests.some((p) => p.kind === 'access') && ' Your request is waiting for a reply.'}
            </p>
          ) : (
            <ul className="workspace-list">
              {work.versions.map((v) => (
                <li key={v.id}>
                  <div>
                    <strong>
                      Version {v.version} · {v.filename}
                    </strong>
                    <small>
                      {formatSize(v.size)} · {formatDateTime(v.createdAt)}
                      {v.note && ` · ${v.note}`}
                    </small>
                  </div>
                  <a href={networkApi.downloadUrl(work.id, v.id)} aria-label={`Download version ${v.version}`}>
                    <Download size={15} aria-hidden="true" />
                  </a>
                  <span />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {work.ownership.length > 0 && (
        <section className="net-section">
          <h2 className="section-label">Ownership record</h2>
          {work.claimed ? (
            <p className="net-explain">
              The claim is recorded in NemoSearch's hash-chained log, which can only be added to. No file was uploaded:
              the fingerprint is a SHA-256 of the DOI and the authorship evidence above. The record shows which
              ORCID-verified account made the claim, and when, by this server's clock. It is evidence of the claim, not a
              certificate of authorship.
            </p>
          ) : (
            <p className="net-explain">
              Every upload is fingerprinted with SHA-256 and appended to NemoSearch's hash-chained log, which can only be
              added to. The record shows which ORCID-verified account uploaded these exact bytes, and when, by this
              server's clock. It is evidence of upload, not a certificate of authorship. To check a copy, compare its
              SHA-256 (for example <code>shasum -a 256 file.pdf</code>) with the fingerprint below.
            </p>
          )}
          <div className="report-table-wrap">
            <table className="net-table">
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">SHA-256 fingerprint</th>
                  <th scope="col">ORCID iD</th>
                  <th scope="col">Recorded (server time)</th>
                  <th scope="col">Log entry</th>
                </tr>
              </thead>
              <tbody>
                {work.ownership.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.event === 'claim' ? 'Claim' : `Upload v${work.versions.find((v) => v.id === r.versionId)?.version ?? '–'}`}
                    </td>
                    <td>
                      <button type="button" className="hash" onClick={() => copy(r.sha256, 'Fingerprint')} title={r.sha256}>
                        {short(r.sha256)} <Copy size={12} aria-hidden="true" />
                      </button>
                    </td>
                    <td>{r.orcid ?? '–'}</td>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>
                      <button type="button" className="hash" onClick={() => copy(r.recordHash, 'Log entry hash')} title={`#${r.seq} · ${r.recordHash}`}>
                        #{r.seq} {short(r.recordHash)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="text-link"
            onClick={() =>
              networkApi
                .verifyChain()
                .then((r) =>
                  r.ok
                    ? ctx.notify(`The ownership log is intact: ${r.records} records, every link verified.`)
                    : ctx.notify('The ownership log failed verification. Contact the NemoSearch admins.', undefined, 'error')
                )
                .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
            }
          >
            <ShieldCheck size={14} aria-hidden="true" /> Verify the whole log
          </button>
        </section>
      )}

      {owner && work.grants && (
        <section className="net-section">
          <h2 className="section-label">People with access · {work.grants.length}</h2>
          {work.grants.length === 0 ? (
            <p className="workspace-empty">
              {work.visibility === 'open' ? 'Anyone can read this work.' : 'Nobody else yet. Invite people by ORCID iD, or approve their requests.'}
            </p>
          ) : (
            <ul className="workspace-list">
              {work.grants.map((g) => (
                <li key={g.id}>
                  <div>
                    <strong>
                      <NetworkLink ctx={ctx} route={{ page: 'person', id: g.id }}>
                        {g.name}
                      </NetworkLink>
                    </strong>
                    <small>
                      {g.orcid && `ORCID ${g.orcid} · `}since {formatDate(g.grantedAt)}
                    </small>
                  </div>
                  <span />
                  <button
                    type="button"
                    aria-label={`Remove access for ${g.name}`}
                    title="Remove access (copies they already downloaded stay with them)"
                    onClick={() =>
                      networkApi
                        .revoke(work.id, g.id)
                        .then(load)
                        .then(() => ctx.notify(`${g.name} no longer has access.`))
                        .catch((e: Error) => ctx.notify(e.message, undefined, 'error'))
                    }
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {owner && work.visibility === 'private' && work.versions.length > 0 && (
        <p className="net-explain">
          <AlertTriangle size={13} aria-hidden="true" /> This work is private. Change its visibility to share it.
        </p>
      )}

      {open === 'visibility' && <VisibilityDialog work={work} onCancel={close} onDone={(w) => updated(w, `Visibility is now ${VISIBILITY[w.visibility].label}.`)} />}
      {open === 'edit' && ctx.me && <EditWorkDialog me={ctx.me} work={work} onCancel={close} onDone={(w) => updated(w, 'Saved the details.')} />}
      {open === 'invite' && (
        <OrcidDialog
          title="Invite someone to read this work"
          hint="They need a NemoSearch account. They'll be able to read and download every version."
          submitLabel="Invite"
          onCancel={close}
          onSubmit={async (orcid) => updated(await networkApi.grant(work.id, orcid), 'Invitation sent.')}
        />
      )}
      {open === 'delete' && (
        <ConfirmDialog
          title="Delete this work?"
          body="Its files and metadata are removed for everyone, and pending requests are cancelled. The ownership record stays in the log as proof of the upload."
          confirmLabel="Delete work"
          onCancel={close}
          onConfirm={async () => {
            await networkApi.deleteWork(work.id)
            close()
            ctx.notify(`Deleted “${work.title}”.`)
            ctx.navigate({ page: 'mine' })
          }}
        />
      )}
      {open === 'request' && (
        <RequestDialog
          work={work}
          onCancel={close}
          onDone={() => {
            close()
            ctx.notify('Request sent. You will be notified when the owner answers.')
            load()
          }}
        />
      )}
      {open === 'abuse' && (
        <AbuseDialog
          targetKind="work"
          targetId={work.id}
          onCancel={close}
          onDone={() => {
            close()
            ctx.notify('Thanks. The report went to the NemoSearch admins.')
          }}
        />
      )}
      {open === 'takedown' && <TakedownDialog work={work} onCancel={close} onDone={(w) => updated(w, 'The work was taken down.')} />}
    </article>
  )
}
