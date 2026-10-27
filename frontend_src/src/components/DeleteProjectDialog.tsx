import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import type { Project } from '../data'

interface DeleteProjectDialogProps {
  project: Project
  onCancel: () => void
  onConfirm: (reports: 'unassign' | 'delete') => Promise<void>
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Explains exactly what deleting a project does before anything is removed. Focus starts on Cancel.
export default function DeleteProjectDialog({ project, onCancel, onConfirm }: DeleteProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [reports, setReports] = useState<'unassign' | 'delete'>('unassign')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { counts } = project

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    dialog?.querySelector<HTMLButtonElement>('.secondary-button')?.focus()
    return () => dialog?.close()
  }, [])

  const removed = [
    'the project',
    'its notes',
    counts.sources && plural(counts.sources, 'saved source'),
    counts.attachments && plural(counts.attachments, 'attachment'),
    counts.exports && plural(counts.exports, 'export record'),
  ].filter(Boolean) as string[]
  const removedText = `${removed.slice(0, -1).join(', ')} and ${removed[removed.length - 1]}`

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog"
      role="alertdialog"
      aria-labelledby="delete-project-title"
      aria-describedby="delete-project-summary"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <form
        className="project-dialog-inner"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            await onConfirm(reports)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'The project could not be deleted.')
            setBusy(false)
          }
        }}
      >
        <header className="project-dialog-header">
          <h2 id="delete-project-title">Delete “{project.name}”?</h2>
          <button type="button" className="routing-close" aria-label="Keep the project" onClick={onCancel} disabled={busy}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div id="delete-project-summary" className="delete-summary">
          <p>
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              This can't be undone. {removedText.charAt(0).toUpperCase() + removedText.slice(1)} will be permanently removed.
            </span>
          </p>
          {counts.reports === 0 && <p>It has no research reports.</p>}
        </div>
        {counts.reports > 0 && (
          <fieldset className="delete-choice">
            <legend>What should happen to its {plural(counts.reports, 'research report')}?</legend>
            <label className="scope-option">
              <input type="radio" name="reports" checked={reports === 'unassign'} onChange={() => setReports('unassign')} />
              <span>
                <strong>Move them to Unassigned</strong>
                <small>Recommended. The reports stay available in your research history.</small>
              </span>
            </label>
            <label className="scope-option">
              <input type="radio" name="reports" checked={reports === 'delete'} onChange={() => setReports('delete')} />
              <span>
                <strong>Delete them too</strong>
                <small>The reports are removed from your history as well.</small>
              </span>
            </label>
          </fieldset>
        )}
        <p className={error ? 'form-error' : 'visually-hidden'} role="alert">
          {error && <AlertTriangle size={14} aria-hidden="true" />}
          {error}
        </p>
        <footer className="project-dialog-footer">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button danger" aria-busy={busy}>
            {busy ? 'Deleting…' : reports === 'delete' && counts.reports > 0 ? 'Delete project and reports' : 'Delete project'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
