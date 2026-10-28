import { useState } from 'react'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import DotField from './DotField'
import Logo from './Logo'
import { api } from '../api'
import type { AuthConfig } from '../network'

const ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled at ORCID.',
  expired: 'That sign-in attempt expired. Try again.',
  orcid_unavailable: "ORCID couldn't confirm your sign-in just now. Try again in a minute.",
  orcid_not_configured: "Sign-in with ORCID isn't set up on this server yet.",
}

interface SignInProps {
  config: AuthConfig | null
  error: string
  /** Where to return after signing in */
  next: string
  onSignedIn: () => void
}

// Shown to anyone without a session. ORCID is the only way in.
export default function SignIn({ config, error, next, onSignedIn }: SignInProps) {
  const [devError, setDevError] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className="signin-shell">
      <DotField />
      <main className="signin-panel">
        <Logo />
        <h1>Research with a verified identity.</h1>
        <p>
          NemoSearch signs you in with ORCID, the free identifier researchers already use for their publications. Your
          research stays private to you; nothing is published unless you choose to.
        </p>
        {error && (
          <p className="form-error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" /> {ERRORS[error] ?? 'Sign-in failed. Try again.'}
          </p>
        )}
        {config?.orcid !== false && (
          <a className="primary-button signin-orcid" href={`/api/auth/orcid/login?next=${encodeURIComponent(next)}`}>
            Sign in with ORCID <ArrowRight size={16} aria-hidden="true" />
          </a>
        )}
        <p className="signin-note">
          No ORCID iD yet?{' '}
          <a href="https://orcid.org/register" target="_blank" rel="noreferrer">
            Register free at orcid.org
          </a>
          . It takes about a minute.
        </p>

        {config?.devLogin && (
          <form
            className="signin-dev"
            onSubmit={async (event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              const name = String(data.get('name') || '').trim()
              if (!name) {
                setDevError('Enter a name.')
                return
              }
              setBusy(true)
              setDevError('')
              try {
                await api.devLogin(name, String(data.get('orcid') || '').trim())
                onSignedIn()
              } catch (e) {
                setDevError((e as Error).message)
                setBusy(false)
              }
            }}
          >
            <div className="section-label">Local development sign-in</div>
            <p>This server allows signing in without ORCID because it runs on localhost. It is refused anywhere else.</p>
            <label className="field">
              <span>Name</span>
              <input name="name" autoComplete="off" placeholder="e.g. Ada Researcher" />
            </label>
            <label className="field">
              <span>
                ORCID iD <small>(optional; a test iD is made up from the name)</small>
              </span>
              <input name="orcid" autoComplete="off" placeholder="0000-0002-1825-0097" />
            </label>
            {devError && (
              <p className="form-error" role="alert">
                <AlertTriangle size={14} aria-hidden="true" /> {devError}
              </p>
            )}
            <button type="submit" className="secondary-button" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in for development'}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
