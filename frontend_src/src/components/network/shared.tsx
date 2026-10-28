import { BadgeCheck, Globe2, Link2, Lock, ShieldOff, UserCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { VISIBILITY, formatDate } from '../../network'
import type { Me, NetworkRoute, WorkSummary } from '../../network'
import type { Project, SavedReport } from '../../data'

/** What every Network page needs from the app around it */
export interface NetworkContext {
  /** Null when someone opens a shared link without an account */
  me: Me | null
  navigate: (route: NetworkRoute) => void
  notify: (message: string, action?: { label: string; run: () => void }, tone?: 'info' | 'error') => void
  refreshMe: () => void
  projects: Project[]
  reports: SavedReport[]
  /** Opens a project in the Library */
  openProject: (projectId: string) => void
  orcidBase: string
}

export function NetworkLink({ ctx, route, children, className }: { ctx: NetworkContext; route: NetworkRoute; children: ReactNode; className?: string }) {
  const href =
    route.page === 'work' ? `/network/works/${route.id}` : route.page === 'person' ? `/network/people/${route.id}` : route.page === 'org' ? `/network/orgs/${route.id}` : `/network/${route.page}`
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        ctx.navigate(route)
      }}
    >
      {children}
    </a>
  )
}

export function VisibilityBadge({ work }: { work: Pick<WorkSummary, 'visibility' | 'takenDown' | 'claimed'> }) {
  if (work.takenDown)
    return (
      <span className="net-badge warn">
        <ShieldOff size={12} aria-hidden="true" /> Taken down
      </span>
    )
  const Icon = work.claimed ? Link2 : work.visibility === 'open' ? Globe2 : work.visibility === 'request' ? UserCheck : Lock
  return (
    <span className={`net-badge ${work.visibility}`}>
      <Icon size={12} aria-hidden="true" /> {work.claimed ? 'Links to original' : VISIBILITY[work.visibility].label}
    </span>
  )
}

export function VerifiedBadge({ label = 'Verified' }: { label?: string }) {
  return (
    <span className="net-badge verified" title="Checked by a NemoSearch admin">
      <BadgeCheck size={12} aria-hidden="true" /> {label}
    </span>
  )
}

export function WorkRow({ ctx, work, showOwner = true }: { ctx: NetworkContext; work: WorkSummary; showOwner?: boolean }) {
  return (
    <li className="net-row">
      <div className="net-row-main">
        <NetworkLink ctx={ctx} route={{ page: 'work', id: work.id }} className="net-row-title">
          {work.title}
        </NetworkLink>
        <small>
          {work.authors.slice(0, 4).join(', ')}
          {work.authors.length > 4 && ' et al.'}
          {showOwner && work.owner && (
            <>
              {' · shared by '}
              {work.owner.name}
            </>
          )}
          {work.org && ` · ${work.org.name}`} · {formatDate(work.updatedAt)}
        </small>
        {work.tags.length > 0 && (
          <span className="net-tags">
            {work.tags.slice(0, 5).map((t) => (
              <span key={t}>{t}</span>
            ))}
          </span>
        )}
      </div>
      <div className="net-row-side">
        <VisibilityBadge work={work} />
        <span className="net-license">{work.license.label}</span>
      </div>
    </li>
  )
}

export function Loading({ what }: { what: string }) {
  return <p className="workspace-empty">Loading {what}…</p>
}

export function LoadError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="workspace-error" role="alert">
      <p>{message}</p>
      {retry && (
        <button type="button" className="text-link" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}
