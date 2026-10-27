import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface ProjectDialogProps {
  mode: 'create' | 'rename'
  initialName?: string
  initialDescription?: string
  onCancel: () => void
  /** Resolves when saved; rejects with a message to show in the dialog */
  onSubmit: (name: string, description: string) => Promise<void>
}

// Create or rename a project. Mounted only while open.
export default function ProjectDialog({ mode, initialName = '', initialDescription = '', onCancel, onSubmit }: ProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    dialog?.querySelector<HTMLInputElement>('#project-name')?.focus()
    return () => dialog?.close()
  }, [])

  const title = mode === 'create' ? 'New project' : 'Rename project'

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog"
      aria-labelledby="project-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <form
        className="project-dialog-inner"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          const name = String(data.get('name') || '').trim()
          if (!name) {
            setError('Give the project a name.')
            dialogRef.current?.querySelector<HTMLInputElement>('#project-name')?.focus()
            return
          }
          setBusy(true)
          setError('')
          try {
            await onSubmit(name, String(data.get('description') || '').trim())
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
            setBusy(false)
          }
        }}
      >
        <header className="project-dialog-header">
          <h2 id="project-dialog-title">{title}</h2>
          <button type="button" className="routing-close" aria-label="Close without saving" onClick={onCancel} disabled={busy}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <p className="project-dialog-hint">
          {mode === 'create'
            ? 'Group the research for a thesis chapter, literature review, grant or R&D investigation.'
            : 'Research, sources and files in this project stay where they are.'}
        </p>
        <label className="field">
          <span>Name</span>
          <input
            id="project-name"
            name="name"
            defaultValue={initialName}
            maxLength={120}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'project-dialog-error' : undefined}
            placeholder="e.g. Thesis chapter 3: solid-state electrolytes"
          />
        </label>
        <label className="field">
          <span>
            Description <small>(optional)</small>
          </span>
          <textarea name="description" defaultValue={initialDescription} maxLength={500} rows={2} />
        </label>
        <p id="project-dialog-error" className={error ? 'form-error' : 'visually-hidden'} role="alert">
          {error && <AlertTriangle size={14} aria-hidden="true" />}
          {error}
        </p>
        <footer className="project-dialog-footer">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" aria-busy={busy}>
            {busy ? 'Saving…' : mode === 'create' ? 'Create project' : 'Save name'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
