import { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, Paperclip, Trash2, Upload, UserPlus, X } from 'lucide-react'
import { api } from '../api'
import ProjectThread from './ProjectThread'
import type { ProjectDetail, SavedSourceRecord } from '../data'

interface ProjectWorkspaceProps {
  /** 'unassigned' or a project id */
  scope: string
  /** Bump to reload after something was saved elsewhere (e.g. a source from a report) */
  refreshKey: number
  notify: (message: string, action?: { label: string; run: () => void }, tone?: 'info' | 'error') => void
  onChanged: () => void
  /** The signed-in account, to tell your own items from collaborators' */
  meId: string
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

// Discussion, sharing, saved sources, attachments and exports for one project (or saved sources for Unassigned)
export default function ProjectWorkspace({ scope, refreshKey, notify, onChanged, meId }: ProjectWorkspaceProps) {
  const isProject = scope !== 'unassigned'
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [sources, setSources] = useState<SavedSourceRecord[]>([])
  const [loadError, setLoadError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const load = isProject ? api.getProject(scope) : api.listSources('unassigned').then((s) => ({ sources: s }) as ProjectDetail)
    load
      .then((data) => {
        if (cancelled) return
        setLoadError('')
        setSources(data.sources)
        if (isProject) setDetail(data)
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
    return () => {
      cancelled = true
    }
  }, [scope, isProject, refreshKey])

  const removeSource = async (source: SavedSourceRecord) => {
    try {
      await api.deleteSource(source.id)
      setSources((prev) => prev.filter((s) => s.id !== source.id))
      notify(`Removed “${source.title}” from saved sources.`, {
        label: 'Undo',
        run: () =>
          api.saveSource(source.projectId, source.reportId, source.source).then((restored) => setSources((prev) => [restored, ...prev])),
      })
      onChanged()
    } catch (e) {
      notify((e as Error).message, undefined, 'error')
    }
  }

  const upload = async (files: FileList | null) => {
    if (!files?.length || !isProject) return
    setUploading(true)
    for (const file of Array.from(files)) {
      try {
        const added = await api.uploadAttachment(scope, file)
        setDetail((prev) => (prev ? { ...prev, attachments: [added, ...prev.attachments] } : prev))
        notify(`Attached “${file.name}” to the project.`)
      } catch (e) {
        notify(`Couldn't attach “${file.name}”: ${(e as Error).message}`, undefined, 'error')
      }
    }
    setUploading(false)
    if (fileInput.current) fileInput.current.value = ''
    onChanged()
  }

  const removeAttachment = async (id: string, filename: string) => {
    try {
      await api.deleteAttachment(id)
      setDetail((prev) => (prev ? { ...prev, attachments: prev.attachments.filter((a) => a.id !== id) } : prev))
      notify(`Removed “${filename}”.`)
      onChanged()
    } catch (e) {
      notify((e as Error).message, undefined, 'error')
    }
  }

  const isOwner = detail?.role === 'owner'

  const addMember = async (orcid: string) => {
    setSharing(true)
    setShareError('')
    try {
      const members = await api.addMember(scope, orcid)
      setDetail((prev) => (prev ? { ...prev, members } : prev))
      notify('Shared. They can now see everything in this project.')
      onChanged()
      return true
    } catch (e) {
      setShareError((e as Error).message)
      return false
    } finally {
      setSharing(false)
    }
  }

  const removeMember = async (id: string, name: string) => {
    try {
      await api.removeMember(scope, id)
      setDetail((prev) => (prev ? { ...prev, members: prev.members.filter((m) => m.id !== id) } : prev))
      notify(`${name} no longer has access to this project.`)
      onChanged()
    } catch (e) {
      notify((e as Error).message, undefined, 'error')
    }
  }

  if (loadError) {
    return (
      <p className="workspace-error" role="alert">
        Couldn't load this {isProject ? 'project' : 'section'}: {loadError}
      </p>
    )
  }

  return (
    <div className="project-workspace">
      {isProject && detail && <ProjectThread projectId={scope} memberCount={detail.members.length} legacyNotes={detail.notes} />}

      {isProject && detail && (
        <section className="workspace-section" aria-labelledby="ws-members">
          <div className="workspace-heading">
            <h2 id="ws-members" className="section-label">
              Shared with · {detail.members.length}
            </h2>
          </div>
          {detail.members.length === 0 ? (
            <p className="workspace-empty">
              {isOwner ? 'Only you. Share it with collaborators by their ORCID iD; they need a NemoSearch account.' : ''}
            </p>
          ) : (
            <ul className="workspace-list">
              {detail.owner && !isOwner && (
                <li>
                  <div>
                    <strong>{detail.owner.name}</strong>
                    <small>Owner{detail.owner.orcid && ` · ORCID ${detail.owner.orcid}`}</small>
                  </div>
                  <span />
                  <span />
                </li>
              )}
              {detail.members.map((m) => (
                <li key={m.id}>
                  <div>
                    <strong>
                      {m.name}
                      {m.id === meId && ' (you)'}
                    </strong>
                    <small>
                      {[m.affiliation, m.orcid && `ORCID ${m.orcid}`].filter(Boolean).join(' · ')}
                    </small>
                  </div>
                  <span />
                  {isOwner ? (
                    <button type="button" onClick={() => removeMember(m.id, m.name)} aria-label={`Stop sharing with ${m.name}`} title="Stop sharing">
                      <X size={15} aria-hidden="true" />
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          )}
          {isOwner && (
            <form
              className="share-form"
              onSubmit={async (event) => {
                event.preventDefault()
                const form = event.currentTarget
                const orcid = String(new FormData(form).get('orcid') || '').trim()
                if (!orcid) return setShareError('Enter their ORCID iD.')
                if (await addMember(orcid)) form.reset()
              }}
            >
              <label className="visually-hidden" htmlFor="share-orcid">
                Collaborator's ORCID iD
              </label>
              <input id="share-orcid" name="orcid" placeholder="Collaborator's ORCID iD, e.g. 0000-0002-1825-0097" autoComplete="off" aria-invalid={shareError ? true : undefined} />
              <button type="submit" className="secondary-button" disabled={sharing}>
                <UserPlus size={15} aria-hidden="true" /> {sharing ? 'Sharing…' : 'Share'}
              </button>
              {shareError && (
                <p className="form-error" role="alert">
                  {shareError}
                </p>
              )}
            </form>
          )}
        </section>
      )}

      <section className="workspace-section" aria-labelledby="ws-sources">
        <div className="workspace-heading">
          <h2 id="ws-sources" className="section-label">
            Saved sources · {sources.length}
          </h2>
        </div>
        {sources.length === 0 ? (
          <p className="workspace-empty">Open a source in a report and choose Save source to keep it here.</p>
        ) : (
          <ul className="workspace-list">
            {sources.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.title}</strong>
                  <small>
                    {source.source.domain || new URL(source.url).hostname} · saved {formatDate(source.createdAt)}
                  </small>
                </div>
                <a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open “${source.title}” in a new tab`}>
                  <ExternalLink size={15} aria-hidden="true" />
                </a>
                {source.mine !== false || isOwner || !isProject ? (
                  <button type="button" onClick={() => removeSource(source)} aria-label={`Remove “${source.title}” from saved sources`}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isProject && detail && (
        <>
          <section className="workspace-section" aria-labelledby="ws-files">
            <div className="workspace-heading">
              <h2 id="ws-files" className="section-label">
                Attachments · {detail.attachments.length}
              </h2>
              <input
                ref={fileInput}
                id="project-file-input"
                type="file"
                multiple
                className="visually-hidden"
                tabIndex={-1}
                aria-label="Add files to the project"
                onChange={(event) => upload(event.target.files)}
              />
              <button type="button" className="text-link" onClick={() => fileInput.current?.click()} disabled={uploading} aria-busy={uploading}>
                <Upload size={14} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Add files'}
              </button>
            </div>
            {detail.attachments.length === 0 ? (
              <p className="workspace-empty">Papers, datasets or drafts you attach are stored with this project on the server (up to 15 MB each).</p>
            ) : (
              <ul className="workspace-list">
                {detail.attachments.map((file) => (
                  <li key={file.id}>
                    <div>
                      <strong>
                        <Paperclip size={13} aria-hidden="true" /> {file.filename}
                      </strong>
                      <small>
                        {formatSize(file.size)} · added {formatDate(file.createdAt)}
                      </small>
                    </div>
                    <a href={`/api/attachments/${file.id}`} download aria-label={`Download “${file.filename}”`}>
                      <Download size={15} aria-hidden="true" />
                    </a>
                    {file.ownerId === meId || isOwner ? (
                      <button type="button" onClick={() => removeAttachment(file.id, file.filename)} aria-label={`Remove “${file.filename}”`}>
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    ) : (
                      <span />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="workspace-section" aria-labelledby="ws-exports">
            <div className="workspace-heading">
              <h2 id="ws-exports" className="section-label">
                Exports · {detail.exports.length}
              </h2>
            </div>
            {detail.exports.length === 0 ? (
              <p className="workspace-empty">PDF and slide-outline exports from this project's reports are listed here.</p>
            ) : (
              <ul className="workspace-list">
                {detail.exports.map((item) => (
                  <li key={item.id}>
                    <div>
                      <strong>
                        <FileText size={13} aria-hidden="true" /> {item.filename}
                      </strong>
                      <small>
                        {item.kind === 'pdf' ? 'Printed to PDF' : 'Slide outline'} · {formatDate(item.createdAt)}
                      </small>
                    </div>
                    {item.downloadable ? (
                      <a href={`/api/exports/${item.id}/download`} aria-label={`Download “${item.filename}” again`}>
                        <Download size={15} aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="workspace-meta">Not stored</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
