import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface DialogProps {
  title: string
  hint?: ReactNode
  submitLabel: string
  busyLabel?: string
  /** Disables the submit button, e.g. until a confirmation box is ticked */
  canSubmit?: boolean
  danger?: boolean
  wide?: boolean
  onCancel: () => void
  /** Resolves when done; rejects with a message to show in the dialog */
  onSubmit: (data: FormData) => Promise<void>
  children: ReactNode
}

// Modal form in the style of the project dialog. Mounted only while open.
export default function Dialog({ title, hint, submitLabel, busyLabel = 'Saving…', canSubmit = true, danger, wide, onCancel, onSubmit, children }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    dialog?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select')?.focus()
    return () => dialog?.close()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit(new FormData(event.currentTarget))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={`project-dialog ${wide ? 'network-dialog-wide' : ''}`}
      aria-labelledby="network-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <form className="project-dialog-inner" noValidate onSubmit={submit}>
        <header className="project-dialog-header">
          <h2 id="network-dialog-title">{title}</h2>
          <button type="button" className="routing-close" aria-label="Close without saving" onClick={onCancel} disabled={busy}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {hint && <p className="project-dialog-hint">{hint}</p>}
        {children}
        <p className={error ? 'form-error' : 'visually-hidden'} role="alert">
          {error && <AlertTriangle size={14} aria-hidden="true" />}
          {error}
        </p>
        <footer className="project-dialog-footer">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`primary-button ${danger ? 'danger' : ''}`} aria-busy={busy} disabled={busy || !canSubmit}>
            {busy ? busyLabel : submitLabel}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
