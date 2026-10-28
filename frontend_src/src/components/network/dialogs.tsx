import { useState } from 'react'
import { AlertTriangle, Lock } from 'lucide-react'
import Dialog from './Dialog'
import { networkApi } from '../../api'
import { LICENSES, VISIBILITY } from '../../network'
import type { LicenseId, Me, NetworkRequest, Organization, Visibility, WorkDetail } from '../../network'
import type { Project, SavedReport } from '../../data'

const lines = (value: FormDataEntryValue | null) =>
  String(value || '')
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean)
const commaList = (value: FormDataEntryValue | null) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

function LicensePicker({ value, onChange }: { value: LicenseId; onChange: (id: LicenseId) => void }) {
  return (
    <fieldset className="choice-group">
      <legend>License</legend>
      {LICENSES.map((license) => (
        <label key={license.id} className="choice">
          <input type="radio" name="license" value={license.id} checked={value === license.id} onChange={() => onChange(license.id)} />
          <span>
            <strong>{license.label}</strong>
            <small>{license.summary}</small>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function WorkFields({ me, initial }: { me: Me; initial?: Partial<WorkDetail> }) {
  return (
    <>
      <label className="field">
        <span>Title</span>
        <input name="title" defaultValue={initial?.title} maxLength={300} required />
      </label>
      <label className="field">
        <span>
          Authors <small>(one per line, in order)</small>
        </span>
        <textarea name="authors" rows={2} defaultValue={(initial?.authors ?? [me.name]).join('\n')} />
      </label>
      <label className="field">
        <span>
          Abstract <small>(public unless the work is private)</small>
        </span>
        <textarea name="abstract" rows={4} maxLength={5000} defaultValue={initial?.abstract} />
      </label>
      <label className="field">
        <span>
          Tags <small>(comma-separated, up to 10)</small>
        </span>
        <input name="tags" defaultValue={initial?.tags?.join(', ')} placeholder="e.g. solid-state batteries, electrolytes" />
      </label>
      {me.organizations.length > 0 && (
        <label className="field">
          <span>
            Publish for <small>(optional)</small>
          </span>
          <select name="orgId" defaultValue={initial?.org?.id ?? ''} className="field-select">
            <option value="">Just me</option>
            {me.organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )
}

const workMeta = (data: FormData) => ({
  title: String(data.get('title') || '').trim(),
  abstract: String(data.get('abstract') || '').trim(),
  authors: lines(data.get('authors')),
  tags: commaList(data.get('tags')),
  orgId: (data.get('orgId') as string) || null,
})

export function PublishDialog({
  me, reports, initialReportId, onCancel, onDone,
}: {
  me: Me
  reports: SavedReport[]
  initialReportId?: string
  onCancel: () => void
  onDone: (work: WorkDetail, uploadError?: string) => void
}) {
  const own = reports.filter((r) => r.mine !== false && r.hasReport !== false)
  const [source, setSource] = useState<'pdf' | 'report'>(initialReportId ? 'report' : 'pdf')
  const [reportId, setReportId] = useState(initialReportId ?? own[0]?.id ?? '')
  const [license, setLicense] = useState<LicenseId>('cc-by')
  const chosen = own.find((r) => r.id === reportId)

  return (
    <Dialog
      title="Publish a work"
      wide
      hint="It starts Private: only you can see it. You choose who else can, and confirm the rights, on the next step."
      submitLabel="Create private work"
      busyLabel="Publishing…"
      onCancel={onCancel}
      onSubmit={async (data) => {
        const meta = workMeta(data)
        if (!meta.title) throw new Error('Give the work a title.')
        const file = data.get('file') as File | null
        if (source === 'pdf' && (!file || !file.size)) throw new Error('Choose a PDF to upload.')
        if (source === 'pdf' && file && file.type && file.type !== 'application/pdf') throw new Error('Upload a PDF file.')
        const work = await networkApi.createWork({ ...meta, license, reportId: source === 'report' ? reportId : undefined })
        if (source === 'pdf' && file) {
          try {
            onDone(await networkApi.uploadVersion(work.id, file, 'First version'))
          } catch (e) {
            onDone(work, (e as Error).message)
          }
        } else onDone(work)
      }}
    >
      <fieldset className="choice-group inline">
        <legend>What are you publishing?</legend>
        <label className="choice">
          <input type="radio" name="source" checked={source === 'pdf'} onChange={() => setSource('pdf')} />
          <span>
            <strong>A PDF</strong>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="source" checked={source === 'report'} onChange={() => setSource('report')} disabled={!own.length} />
          <span>
            <strong>A NemoSearch report</strong>
            {!own.length && <small>Run some research first.</small>}
          </span>
        </label>
      </fieldset>
      {source === 'pdf' ? (
        <label className="field">
          <span>
            PDF <small>(up to 25 MB; a SHA-256 fingerprint is recorded on upload)</small>
          </span>
          <input name="file" type="file" accept="application/pdf,.pdf" />
        </label>
      ) : (
        <label className="field">
          <span>Report</span>
          <select className="field-select" value={reportId} onChange={(e) => setReportId(e.target.value)}>
            {own.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <WorkFields key={source === 'report' ? reportId : 'pdf'} me={me} initial={{ title: source === 'report' ? chosen?.title : '' }} />
      <LicensePicker value={license} onChange={setLicense} />
    </Dialog>
  )
}

export function EditWorkDialog({ me, work, onCancel, onDone }: { me: Me; work: WorkDetail; onCancel: () => void; onDone: (w: WorkDetail) => void }) {
  return (
    <Dialog
      title="Edit details"
      wide
      submitLabel="Save details"
      onCancel={onCancel}
      onSubmit={async (data) => {
        const meta = workMeta(data)
        if (!meta.title) throw new Error('Give the work a title.')
        onDone(await networkApi.updateWork(work.id, me.organizations.length ? meta : { ...meta, orgId: undefined }))
      }}
    >
      <WorkFields me={me} initial={work} />
    </Dialog>
  )
}

export function VisibilityDialog({ work, onCancel, onDone }: { work: WorkDetail; onCancel: () => void; onDone: (w: WorkDetail) => void }) {
  const [visibility, setVisibility] = useState<Visibility>(work.visibility)
  const [license, setLicense] = useState<LicenseId>((work.license.id as LicenseId) ?? 'cc-by')
  const [confirmed, setConfirmed] = useState(false)
  const licenseLabel = LICENSES.find((l) => l.id === license)?.label ?? license
  const changesTerms = visibility !== work.visibility || (!work.claimed && license !== work.license.id)
  const needsConfirm = visibility !== 'private' && changesTerms

  return (
    <Dialog
      title="Who can see this work?"
      wide
      submitLabel={visibility === 'open' && work.visibility !== 'open' ? 'Make it Open' : 'Save'}
      canSubmit={!needsConfirm || confirmed}
      onCancel={onCancel}
      onSubmit={async () => {
        onDone(await networkApi.updateWork(work.id, {
          visibility, ...(work.claimed ? {} : { license }), confirmRights: needsConfirm ? confirmed : false,
        }))
      }}
    >
      <fieldset className="choice-group">
        <legend>Visibility</legend>
        {(Object.keys(VISIBILITY) as Visibility[]).map((v) => (
          <label key={v} className="choice">
            <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} />
            <span>
              <strong>{VISIBILITY[v].label}</strong>
              <small>{VISIBILITY[v].summary}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {!work.claimed && <LicensePicker value={license} onChange={setLicense} />}
      {needsConfirm && (
        <div className="rights-confirm">
          <p>
            <AlertTriangle size={14} aria-hidden="true" />
            {visibility === 'open'
              ? `Anyone on the internet will be able to read and download this work under ${licenseLabel}.`
              : `People you approve will receive a copy of this work under ${licenseLabel}.`}{' '}
            Once someone has a copy, it can't be taken back.
          </p>
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              I hold the rights to share this work under {licenseLabel}. If a journal published it, I've checked that my
              agreement lets me share this version.
            </span>
          </label>
        </div>
      )}
    </Dialog>
  )
}

export function RequestDialog({ work, onCancel, onDone }: { work: WorkDetail; onCancel: () => void; onDone: () => void }) {
  const canAskAccess = work.visibility === 'request' && !work.viewer.canDownload
  const pending = new Set(work.viewer.pendingRequests.map((p) => p.kind))
  const [kind, setKind] = useState<'access' | 'collaborate'>(canAskAccess && !pending.has('access') ? 'access' : 'collaborate')
  return (
    <Dialog
      title="Send a request"
      hint={`${work.owner?.name ?? 'The owner'} will see your name, ORCID iD and affiliation, and this message. Your email is never shared.`}
      submitLabel="Send request"
      busyLabel="Sending…"
      onCancel={onCancel}
      onSubmit={async (data) => {
        await networkApi.sendRequest(work.id, kind, String(data.get('message') || ''))
        onDone()
      }}
    >
      <fieldset className="choice-group">
        <legend>You'd like to</legend>
        {canAskAccess && (
          <label className="choice">
            <input type="radio" checked={kind === 'access'} disabled={pending.has('access')} onChange={() => setKind('access')} />
            <span>
              <strong>Read the full work</strong>
              <small>{pending.has('access') ? 'Your request is waiting for a reply.' : 'The owner decides whether to share the file with you.'}</small>
            </span>
          </label>
        )}
        <label className="choice">
          <input type="radio" checked={kind === 'collaborate'} disabled={pending.has('collaborate')} onChange={() => setKind('collaborate')} />
          <span>
            <strong>Collaborate</strong>
            <small>
              {pending.has('collaborate')
                ? 'Your request is waiting for a reply.'
                : 'If the owner accepts, you both get a shared project in your Library to work in.'}
            </small>
          </span>
        </label>
      </fieldset>
      <label className="field">
        <span>
          Message <small>(who you are and why; up to 1000 characters)</small>
        </span>
        <textarea name="message" rows={4} maxLength={1000} />
      </label>
    </Dialog>
  )
}

export function DecisionDialog({
  request, accept, projects, onCancel, onDone,
}: {
  request: NetworkRequest
  accept: boolean
  projects: Project[]
  onCancel: () => void
  onDone: (r: NetworkRequest) => void
}) {
  const own = projects.filter((p) => p.role === 'owner' && !p.archived)
  const [target, setTarget] = useState<'new' | 'existing'>('new')
  const [projectId, setProjectId] = useState(own[0]?.id ?? '')
  const collaborate = request.kind === 'collaborate'
  return (
    <Dialog
      title={accept ? (collaborate ? 'Accept collaboration' : 'Share this work') : 'Decline request'}
      hint={
        accept
          ? collaborate
            ? `${request.requester?.name} will be able to read “${request.work?.title}” and work with you in a shared project.`
            : `${request.requester?.name} will be able to read and download “${request.work?.title}”.`
          : `${request.requester?.name} will see that you declined, and your note if you add one.`
      }
      submitLabel={accept ? 'Accept' : 'Decline'}
      onCancel={onCancel}
      onSubmit={async (data) => {
        const response = String(data.get('response') || '')
        onDone(
          accept
            ? await networkApi.accept(request.id, response, collaborate && target === 'existing' ? projectId : undefined)
            : await networkApi.decline(request.id, response)
        )
      }}
    >
      {accept && collaborate && (
        <fieldset className="choice-group">
          <legend>Where to collaborate</legend>
          <label className="choice">
            <input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} />
            <span>
              <strong>A new shared project</strong>
              <small>Named after the work, owned by you.</small>
            </span>
          </label>
          <label className="choice">
            <input type="radio" checked={target === 'existing'} disabled={!own.length} onChange={() => setTarget('existing')} />
            <span>
              <strong>One of my projects</strong>
              <small>They'll see all research, sources and files in it.</small>
            </span>
          </label>
          {target === 'existing' && (
            <select className="field-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project to share">
              {own.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </fieldset>
      )}
      <label className="field">
        <span>
          Note <small>(optional)</small>
        </span>
        <textarea name="response" rows={3} maxLength={1000} />
      </label>
    </Dialog>
  )
}

export function OrcidDialog({
  title, hint, submitLabel, withRole, onCancel, onSubmit,
}: {
  title: string
  hint: string
  submitLabel: string
  withRole?: boolean
  onCancel: () => void
  onSubmit: (orcid: string, role: 'admin' | 'member') => Promise<void>
}) {
  return (
    <Dialog
      title={title}
      hint={hint}
      submitLabel={submitLabel}
      onCancel={onCancel}
      onSubmit={async (data) => {
        const orcid = String(data.get('orcid') || '').trim()
        if (!orcid) throw new Error('Enter their ORCID iD.')
        await onSubmit(orcid, (data.get('role') as 'admin' | 'member') || 'member')
      }}
    >
      <label className="field">
        <span>ORCID iD</span>
        <input name="orcid" autoComplete="off" placeholder="0000-0002-1825-0097" />
      </label>
      {withRole && (
        <label className="field">
          <span>Role</span>
          <select name="role" className="field-select" defaultValue="member">
            <option value="member">Member: can publish for the organization</option>
            <option value="admin">Admin: can also manage members and details</option>
          </select>
        </label>
      )}
    </Dialog>
  )
}

export function ClaimDialog({ onCancel, onDone }: { onCancel: () => void; onDone: (w: WorkDetail) => void }) {
  return (
    <Dialog
      title="Claim a published paper"
      hint="List a paper you published elsewhere on your profile. It links to the original; nothing is copied. It works when the paper is on your public ORCID record, or when OpenAlex lists your ORCID iD among its authors."
      submitLabel="Check and claim"
      busyLabel="Checking OpenAlex…"
      onCancel={onCancel}
      onSubmit={async (data) => onDone(await networkApi.claim(String(data.get('doi') || '')))}
    >
      <label className="field">
        <span>DOI</span>
        <input name="doi" autoComplete="off" placeholder="10.48550/arXiv.2101.03961" />
      </label>
    </Dialog>
  )
}

const REASONS = [
  { id: 'copyright', label: 'Copyright', summary: 'It shares something the uploader has no right to share.' },
  { id: 'impersonation', label: 'Impersonation', summary: 'Someone is posing as another researcher or organization.' },
  { id: 'spam', label: 'Spam', summary: 'Unwanted promotion or repeated requests.' },
  { id: 'harassment', label: 'Harassment', summary: 'Abusive or threatening content or messages.' },
  { id: 'other', label: 'Something else', summary: 'Describe it below.' },
]

export function AbuseDialog({ targetKind, targetId, onCancel, onDone }: { targetKind: 'work' | 'user'; targetId: string; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('copyright')
  return (
    <Dialog
      title={targetKind === 'work' ? 'Report this work' : 'Report this researcher'}
      hint="Reports go to the NemoSearch admins, not to the person you're reporting."
      submitLabel="Send report"
      busyLabel="Sending…"
      onCancel={onCancel}
      onSubmit={async (data) => {
        await networkApi.reportAbuse(targetKind, targetId, reason, String(data.get('details') || ''))
        onDone()
      }}
    >
      <fieldset className="choice-group">
        <legend>Reason</legend>
        {REASONS.map((r) => (
          <label key={r.id} className="choice">
            <input type="radio" checked={reason === r.id} onChange={() => setReason(r.id)} />
            <span>
              <strong>{r.label}</strong>
              <small>{r.summary}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>
          Details <small>{reason === 'copyright' ? '(who holds the rights, and how to reach you)' : '(optional)'}</small>
        </span>
        <textarea name="details" rows={3} maxLength={2000} />
      </label>
    </Dialog>
  )
}

export function OrgDialog({ org, onCancel, onDone }: { org?: Organization; onCancel: () => void; onDone: (o: Organization) => void }) {
  return (
    <Dialog
      title={org ? 'Edit organization' : 'New organization'}
      hint={
        org
          ? 'Changing the name or ROR id removes the verified badge until an admin checks again.'
          : 'For a lab, company or institute. A NemoSearch admin checks it before it gets a verified badge.'
      }
      submitLabel={org ? 'Save' : 'Create organization'}
      onCancel={onCancel}
      onSubmit={async (data) => {
        const body = {
          name: String(data.get('name') || '').trim(),
          rorId: String(data.get('rorId') || '').trim(),
          website: String(data.get('website') || '').trim(),
          description: String(data.get('description') || '').trim(),
        }
        if (!body.name) throw new Error('Give the organization a name.')
        onDone(org ? await networkApi.updateOrg(org.id, body) : await networkApi.createOrg(body))
      }}
    >
      <label className="field">
        <span>Name</span>
        <input name="name" defaultValue={org?.name} maxLength={200} />
      </label>
      <label className="field">
        <span>
          ROR id <small>(optional; find it at ror.org)</small>
        </span>
        <input name="rorId" defaultValue={org?.rorId ?? ''} placeholder="05m7pjf47" />
      </label>
      <label className="field">
        <span>
          Website <small>(optional)</small>
        </span>
        <input name="website" defaultValue={org?.website} placeholder="https://" />
      </label>
      <label className="field">
        <span>
          About <small>(optional)</small>
        </span>
        <textarea name="description" rows={3} defaultValue={org?.description} maxLength={2000} />
      </label>
    </Dialog>
  )
}

export function ConfirmDialog({
  title, body, confirmLabel, danger = true, onCancel, onConfirm,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: (data: FormData) => Promise<void>
}) {
  return (
    <Dialog title={title} hint={body} submitLabel={confirmLabel} danger={danger} onCancel={onCancel} onSubmit={onConfirm}>
      <span className="visually-hidden">{body}</span>
    </Dialog>
  )
}

export function TakedownDialog({ work, onCancel, onDone }: { work: WorkDetail; onCancel: () => void; onDone: (w: WorkDetail) => void }) {
  return (
    <Dialog
      title="Take this work down"
      hint="It disappears for everyone except its owner and admins. The owner is notified with your reason."
      submitLabel="Take down"
      danger
      onCancel={onCancel}
      onSubmit={async (data) => onDone(await networkApi.adminTakedown(work.id, true, String(data.get('reason') || '')))}
    >
      <label className="field">
        <span>Reason shown to the owner</span>
        <textarea name="reason" rows={3} maxLength={1000} placeholder="e.g. Copyright notice received from the publisher" />
      </label>
    </Dialog>
  )
}

export function PrivateNote() {
  return (
    <p className="private-note">
      <Lock size={13} aria-hidden="true" /> Only you can see this.
    </p>
  )
}
