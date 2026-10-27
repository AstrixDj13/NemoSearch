import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertTriangle, BookOpen, BrainCircuit, ChevronDown, PenLine, ScanSearch, ShieldCheck, X } from 'lucide-react'
import { isAvailable, modelLabel, presetInfo, presetOrder, routingModels, teamSteps } from '../routing'
import type { Preset, Routing, RoutingScope, TeamModels, TeamStep } from '../routing'

const stepIcons: Record<TeamStep, typeof BrainCircuit> = {
  planner: BrainCircuit,
  scout: ScanSearch,
  reader: BookOpen,
  critic: ShieldCheck,
  writer: PenLine,
}

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface RoutingEditorProps {
  routing: Routing
  presets: Record<Preset, TeamModels>
  modelOptions: string[]
  providerOptions: string[]
  catalogStatus: 'loading' | 'ready' | 'error'
  onCancel: () => void
  onSave: (routing: Routing, scope: RoutingScope) => void
}

// Mounted only while open, so every opening starts from the saved configuration
export default function RoutingEditor({
  routing,
  presets,
  modelOptions,
  providerOptions,
  catalogStatus,
  onCancel,
  onSave,
}: RoutingEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<Routing>(() => ({ ...routing, models: routingModels(routing, presets) }))
  const [editing, setEditing] = useState<TeamStep | null>(null)
  const [scope, setScope] = useState<RoutingScope>('default')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    // Start on the active preset; for a custom routing start on the heading, so an arrow key can't wipe it
    const target =
      dialog?.querySelector<HTMLElement>('input[name="routing-preset"]:checked') ?? dialog?.querySelector<HTMLElement>('#routing-title')
    target?.focus()
    return () => dialog?.close()
  }, [])

  const focusInDialog = (selector: string) =>
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(selector)?.focus())

  const available = (step: TeamStep, model: string) => isAvailable(step, model, modelOptions, providerOptions)
  const unavailableSteps = teamSteps.filter((step) => !available(step.key, draft.models[step.key]))

  const choosePreset = (preset: Preset) => {
    setDraft({ preset, models: presets[preset] })
    setEditing(null)
    setError('')
  }

  const changeModel = (step: TeamStep, model: string) => {
    if (draft.models[step] === model) return
    setDraft({ preset: 'custom', models: { ...draft.models, [step]: model } })
    setError('')
    const name = teamSteps.find((s) => s.key === step)?.name
    setStatus(`${name} model set to ${modelLabel(model)}. Preset is now Custom.`)
  }

  const restoreDefaults = () => {
    choosePreset('balanced')
    setStatus('Recommended Balanced routing restored. Save configuration to apply it.')
    // The button disables itself, so hand focus to the preset that is now selected
    focusInDialog('input[name="routing-preset"][value="balanced"]')
  }

  const save = () => {
    if (unavailableSteps.length > 0) {
      const names = unavailableSteps.map((s) => s.name).join(', ')
      setError(`Can't save yet. ${names} ${unavailableSteps.length > 1 ? 'use models that are' : 'uses a model that is'} unavailable. Choose another model first.`)
      focusInDialog(`#agent-change-${unavailableSteps[0].key}`)
      return
    }
    onSave(draft, scope)
  }

  // Keep Tab and Shift+Tab inside the dialog
  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && el.form?.querySelector(`input[name="${el.name}"]:checked`))
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const isDefault = draft.preset === 'balanced'
  const info = presetInfo[draft.preset]

  return (
    <dialog
      ref={dialogRef}
      className="routing-drawer"
      aria-labelledby="routing-title"
      aria-describedby="routing-desc"
      onKeyDown={trapFocus}
      onCancel={(event) => {
        // Escape closes without saving
        event.preventDefault()
        onCancel()
      }}
      onClick={(event) => {
        // Clicks on the backdrop land on the dialog element itself
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        className="routing-inner"
        noValidate
        onFocus={(event) => {
          // Bring the focused control's whole row (label, description, notes) into view, not just the control
          const row = (event.target as HTMLElement).closest('label, .agent-row')
          row?.scrollIntoView({ block: 'nearest' })
        }}
        onKeyDown={(event) => {
          // Enter on a model selector confirms the choice; it must never save the whole form
          if (event.key === 'Enter' && event.target instanceof HTMLSelectElement) event.preventDefault()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <header className="routing-header">
          <div>
            <h2 id="routing-title" tabIndex={-1}>
              Customize research routing
            </h2>
            <p id="routing-desc">Pick a preset, or change the model behind a single agent. Escape closes without saving.</p>
          </div>
          <button type="button" className="routing-close" aria-label="Close without saving" onClick={onCancel}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="routing-body">
          {catalogStatus === 'error' && (
            <p className="routing-notice" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>Couldn't load the model catalog. Presets still work, but other models can't be listed right now.</span>
            </p>
          )}

          <fieldset className="routing-presets">
            <legend className="section-label">Preset</legend>
            <div className="preset-options">
              {presetOrder.map((preset) => (
                <label className="preset-option" key={preset}>
                  <input
                    type="radio"
                    name="routing-preset"
                    value={preset}
                    checked={draft.preset === preset}
                    onChange={() => choosePreset(preset)}
                    aria-describedby="preset-description"
                  />
                  <span>{presetInfo[preset].label}</span>
                  {preset === 'balanced' && <small>Recommended</small>}
                </label>
              ))}
            </div>
            <p className="preset-description" id="preset-description">
              {draft.preset === 'custom' && <strong>Custom. </strong>}
              {info.description}
            </p>
          </fieldset>

          <fieldset className="routing-agents">
            <legend className="section-label">Agents</legend>
            <ul className="agent-list">
              {teamSteps.map((step) => {
                const Icon = stepIcons[step.key]
                const current = draft.models[step.key]
                const currentLabel = modelLabel(current)
                const isOpen = editing === step.key
                const isAvailableModel = available(step.key, current)
                const options = step.key === 'scout' ? providerOptions : modelOptions
                // Keep the server's order (Nano, Super, Ultra, …) regardless of the current choice
                const choices = [...new Set([...options, current])]
                // Only NVIDIA models are offered; a saved non-NVIDIA choice is shown once, as unavailable
                const nvidia = choices.filter((m) => m.toLowerCase().startsWith('nvidia/'))
                const noteId = `agent-note-${step.key}`
                const option = (m: string) => {
                  const usable = available(step.key, m)
                  return (
                    <option key={m} value={m} title={m} disabled={!usable}>
                      {modelLabel(m)}
                      {usable ? '' : ' (unavailable)'}
                    </option>
                  )
                }
                return (
                  <li className={`agent-row ${isOpen ? 'editing' : ''} ${isAvailableModel ? '' : 'unavailable'}`} key={step.key}>
                    <div className="agent-row-main">
                      <span className="agent-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span className="agent-text">
                        <strong>{step.name}</strong>
                        <span>{step.purpose}</span>
                      </span>
                      <span className="agent-side">
                        <span className="agent-model">
                          {currentLabel}
                          {!isAvailableModel && ' (unavailable)'}
                        </span>
                        <button
                          type="button"
                          id={`agent-change-${step.key}`}
                          className="agent-change"
                          aria-label={`${isOpen ? 'Close' : 'Change'} ${step.name} model, currently ${currentLabel}`}
                          aria-expanded={isOpen}
                          aria-controls={`agent-select-${step.key}`}
                          aria-describedby={isAvailableModel ? undefined : noteId}
                          onClick={() => setEditing(isOpen ? null : step.key)}
                        >
                          {isOpen ? 'Close' : 'Change'}
                        </button>
                      </span>
                    </div>
                    {!isAvailableModel && (
                      <p className="agent-note" id={noteId}>
                        <AlertTriangle size={13} aria-hidden="true" />
                        Unavailable: {currentLabel}{' '}
                        {current.toLowerCase().startsWith('nvidia/') || step.key === 'scout'
                          ? "isn't in the current model catalog."
                          : 'is not an NVIDIA model, and only NVIDIA models are offered.'}{' '}
                        Choose another model; it won't be swapped automatically.
                      </p>
                    )}
                    {isOpen && (
                      <div className="agent-select" id={`agent-select-${step.key}`}>
                        <label className="visually-hidden" htmlFor={`agent-model-${step.key}`}>
                          {step.name} model
                        </label>
                        <div className="team-select">
                          <select
                            id={`agent-model-${step.key}`}
                            value={current}
                            autoFocus
                            aria-describedby={isAvailableModel ? undefined : noteId}
                            onChange={(event) => changeModel(step.key, event.target.value)}
                          >
                            {step.key === 'scout' ? (
                              choices.map(option)
                            ) : (
                              <>
                                {!nvidia.includes(current) && option(current)}
                                <optgroup label="NVIDIA Nemotron">{nvidia.map(option)}</optgroup>
                              </>
                            )}
                          </select>
                          <ChevronDown size={13} aria-hidden="true" />
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </fieldset>

          <fieldset className="routing-scope">
            <legend className="section-label">Apply to</legend>
            <label className="scope-option">
              <input type="radio" name="routing-scope" checked={scope === 'run'} onChange={() => setScope('run')} />
              <span>
                <strong>Next research run only</strong>
                <small>Your saved default stays as it is.</small>
              </span>
            </label>
            <label className="scope-option">
              <input type="radio" name="routing-scope" checked={scope === 'default'} onChange={() => setScope('default')} />
              <span>
                <strong>All runs</strong>
                <small>Save this as your default routing.</small>
              </span>
            </label>
          </fieldset>
        </div>

        <div className="routing-messages">
          <p className="visually-hidden" role="status" aria-live="polite">
            {status}
          </p>
          <p className={error ? 'routing-error' : 'visually-hidden'} role="alert">
            {error && <AlertTriangle size={15} aria-hidden="true" />}
            {error}
          </p>
        </div>

        <footer className="routing-footer">
          <button type="button" className="text-button" onClick={restoreDefaults} disabled={isDefault}>
            Restore defaults
          </button>
          <div>
            <button type="button" className="secondary-button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="primary-button">
              Save configuration
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
