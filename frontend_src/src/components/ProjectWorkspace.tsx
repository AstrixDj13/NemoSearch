import { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, Paperclip, Trash2, Upload } from 'lucide-react'
import { api } from '../api'
import type { ProjectDetail, SavedSourceRecord } from '../data'

interface ProjectWorkspaceProps {
  /** 'unassigned' or a project id */
  scope: string
  /** Bump to reload after something was saved elsewhere (e.g. a source from a report) */
  refreshKey: number
  notify: (message: string, action?: { label: string; run: () => void }, tone?: 'info' | 'error') => void
  onChanged: () => void
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

// Notes, saved sources, attachments and exports for one project (or saved sources for Unassigned)
export default function ProjectWorkspace({ scope, refreshKey, notify, onChanged }: ProjectWorkspaceProps) {
  const isProject = scope !== 'unassigned'
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [sources, setSources] = useState<SavedSourceRecord[]>([])
  const [loadError, setLoadError] = useState('')
  const [notes, setNotes] = useState('')
  const [noteStatus, setNoteStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [uploading, setUploading] = useState(false)
  const noteTimer = useRef<number | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const load = isProject ? api.getProject(scope) : api.listSources('unassigned').then((s) => ({ sources: s }) as ProjectDetail)
    load
      .then((data) => {
        if (cancelled) return
        setLoadError('')
        setSources(data.sources)
        if (isProject) {
          setDetail(data)
          setNotes(data.notes)
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
    return () => {
      cancelled = true
    }
  }, [scope, isProject, refreshKey])

  useEffect(() => () => window.clearTimeout(noteTimer.current), [])

  const saveNotes = (value: string) => {
    setNoteStatus('saving')
    api
      .updateProject(scope, { notes: value })
      .then(() => setNoteStatus('saved'))
      .catch(() => setNoteStatus('error'))
  }

  const onNotesChange = (value: string) => {
    setNotes(value)
    setNoteStatus('saving')
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => saveNotes(value), 700)
  }

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

  if (loadError) {
    return (
      <p className="workspace-error" role="alert">
        Couldn't load this {isProject ? 'project' : 'section'}: {loadError}
      </p>
    )
  }

  return (
    <div className="project-workspace">
      {isProject && (
        <section className="workspace-section" aria-labelledby="ws-notes">
          <div className="workspace-heading">
            <h2 id="ws-notes" className="section-label">
              Notes
            </h2>
            <span className="workspace-status" role="status">
              {noteStatus === 'saving' && 'Saving…'}
              {noteStatus === 'saved' && 'Saved on the server'}
              {noteStatus === 'error' && (
                <>
                  Couldn't save.{' '}
                  <button type="button" className="text-link" onClick={() => saveNotes(notes)}>
                    Retry
                  </button>
                </>
              )}
            </span>
          </div>
          <label className="visually-hidden" htmlFor="project-notes">
            Project notes
          </label>
          <textarea
            id="project-notes"
            className="workspace-notes"
            value={notes}
            onChange={(event) => onNotesChange(event.target.value)}
            placeholder="Working notes, open questions, decisions…"
            rows={4}
          />
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
                <button type="button" onClick={() => removeSource(source)} aria-label={`Remove “${source.title}” from saved sources`}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
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
                    <button type="button" onClick={() => removeAttachment(file.id, file.filename)} aria-label={`Remove “${file.filename}”`}>
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
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
