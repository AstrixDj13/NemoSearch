import { useCallback, useEffect, useState } from 'react'
import App from './App'
import Logo from './components/Logo'
import SignIn from './components/SignIn'
import NetworkView from './components/network/NetworkView'
import { SIGNED_OUT_EVENT, api } from './api'
import { isPublicRoute, pathForRoute, routeFromPath } from './network'
import type { AuthConfig, Me, NetworkRoute } from './network'

// Decides what a visitor sees: the app when signed in, a shared Network page when they followed a link to one,
// and the ORCID sign-in page otherwise.
export default function Root() {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [status, setStatus] = useState<'loading' | 'in' | 'out'>('loading')
  const [publicToast, setPublicToast] = useState('')
  const [publicRoute, setPublicRoute] = useState<NetworkRoute | null>(() => routeFromPath(window.location.pathname))
  const [authError] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const error = params.get('auth_error') || ''
    if (error) window.history.replaceState(null, '', window.location.pathname)
    return error
  })

  const refreshMe = useCallback(() => {
    api
      .me()
      .then((m) => {
        setMe(m)
        setStatus('in')
      })
      .catch(() => setStatus((s) => (s === 'in' ? s : 'out')))
  }, [])

  useEffect(() => {
    api.authConfig().then(setConfig, () => setConfig(null))
    refreshMe()
    const signedOut = () => {
      setMe(null)
      setStatus('out')
    }
    window.addEventListener(SIGNED_OUT_EVENT, signedOut)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut)
  }, [refreshMe])

  // Keeps request and notification counts current while the tab is open
  useEffect(() => {
    if (status !== 'in') return
    const timer = window.setInterval(() => document.visibilityState === 'visible' && refreshMe(), 60_000)
    return () => window.clearInterval(timer)
  }, [status, refreshMe])

  useEffect(() => {
    const onPop = () => setPublicRoute(routeFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  if (status === 'loading') return <div className="signin-shell" aria-busy="true" />

  if (status === 'in' && me) return <App me={me} orcidBase={config?.orcidBase ?? 'https://orcid.org'} refreshMe={refreshMe} />

  if (isPublicRoute(publicRoute) || publicRoute?.page === 'discover') {
    const navigate = (route: NetworkRoute) => {
      window.history.pushState(null, '', pathForRoute(route))
      setPublicRoute(route)
      window.scrollTo(0, 0)
    }
    return (
      <div className="public-shell">
        <header className="public-header">
          <a href="/network" onClick={(e) => (e.preventDefault(), navigate({ page: 'discover' }))}>
            <Logo />
          </a>
          <a className="primary-button" href={`/api/auth/orcid/login?next=${encodeURIComponent(window.location.pathname)}`}>
            Sign in with ORCID
          </a>
        </header>
        <main className="main-content">
          <NetworkView
            route={publicRoute!}
            onPublish={() => undefined}
            ctx={{
              me: null, navigate, refreshMe, projects: [], reports: [], openProject: () => undefined,
              orcidBase: config?.orcidBase ?? 'https://orcid.org',
              notify: (message) => {
                setPublicToast(message)
                window.setTimeout(() => setPublicToast(''), 4000)
              },
            }}
          />
        </main>
        <div className="toast-region" role="status" aria-live="polite">
          {publicToast && <div className="toast info">{publicToast}</div>}
        </div>
      </div>
    )
  }

  return <SignIn config={config} error={authError} next={window.location.pathname} onSignedIn={refreshMe} />
}
