// Accounts and NemoSearch Network: shapes returned by the server and the Network page addresses.

export interface PublicUser {
  id: string
  name: string
  orcid: string | null
  affiliation: string
  bio: string
  interests: string[]
  createdAt: number
}

export interface Me extends PublicUser {
  /** Private: only used to email notifications, never shown to anyone else */
  notifyEmail: string
  isAdmin: boolean
  organizations: { id: string; name: string; verified: boolean; role: 'admin' | 'member' }[]
  unreadNotifications: number
  pendingRequests: number
}

export interface AuthConfig {
  orcid: boolean
  orcidBase: string
  devLogin: boolean
}

export type Visibility = 'private' | 'request' | 'open'
export type LicenseId = 'cc-by' | 'cc-by-nc' | 'cc0' | 'arr'

export const LICENSES: { id: LicenseId; label: string; summary: string }[] = [
  { id: 'cc-by', label: 'CC BY 4.0', summary: 'Anyone may reuse it, including commercially, with credit.' },
  { id: 'cc-by-nc', label: 'CC BY-NC 4.0', summary: 'Reuse with credit, for non-commercial purposes only.' },
  { id: 'cc0', label: 'CC0 1.0', summary: 'Public domain: anyone may reuse it without conditions.' },
  { id: 'arr', label: 'All rights reserved', summary: 'People may read it; reuse needs your permission.' },
]

export const VISIBILITY: Record<Visibility, { label: string; summary: string }> = {
  private: { label: 'Private', summary: 'Only you and people you invite. Never listed or searchable.' },
  request: { label: 'Request access', summary: 'Title, authors and abstract are public. The file is shared only with people you approve.' },
  open: { label: 'Open', summary: 'Anyone, signed in or not, can read and download it.' },
}

export interface WorkVersion {
  id: string
  version: number
  filename: string
  contentType: string
  size: number
  sha256: string
  note: string
  createdAt: number
}

export interface OwnershipRecord {
  id: string
  event: 'upload' | 'claim'
  versionId: string | null
  orcid: string | null
  sha256: string
  size: number
  filename: string
  createdAt: number
  recordHash: string
  prevHash: string
  seq: number
}

export interface WorkSummary {
  id: string
  title: string
  abstract: string
  authors: string[]
  tags: string[]
  license: { id: string; label: string }
  visibility: Visibility
  externalUrl: string | null
  doi: string | null
  claimed: boolean
  /** For a claimed work: what confirmed the claimant is an author */
  claimEvidence: string | null
  takenDown: boolean
  createdAt: number
  updatedAt: number
  owner: { id: string; name: string; orcid: string | null; affiliation: string } | null
  org: { id: string; name: string; verified: boolean } | null
  latestVersion: WorkVersion | null
}

export interface WorkDetail extends WorkSummary {
  versions: WorkVersion[]
  ownership: OwnershipRecord[]
  takedownReason?: string
  viewer: {
    signedIn: boolean
    access: 'owner' | 'admin' | 'granted' | 'open' | 'metadata'
    isOwner: boolean
    canDownload: boolean
    pendingRequests: { id: string; kind: RequestKind }[]
  }
  /** Owner only: people invited or approved */
  grants?: { id: string; name: string; orcid: string | null; grantedAt: number }[]
}

export type RequestKind = 'access' | 'collaborate'

export interface NetworkRequest {
  id: string
  kind: RequestKind
  message: string
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn'
  response: string
  projectId: string | null
  createdAt: number
  decidedAt: number | null
  work: { id: string; title: string } | null
  requester: PublicUser | null
  incoming: boolean
}

export interface NetworkNotification {
  id: string
  kind: string
  data: Record<string, string | null>
  read: boolean
  createdAt: number
}

export interface Person extends PublicUser {
  works: WorkSummary[]
  organizations: { id: string; name: string; verified: boolean }[]
  blockedByYou: boolean
  isYou: boolean
}

export interface Organization {
  id: string
  name: string
  rorId: string | null
  website: string
  description: string
  verified: boolean
  createdAt: number
  yourRole: 'admin' | 'member' | null
  members: (PublicUser & { role: 'admin' | 'member' })[]
  works: WorkSummary[]
}

export interface AbuseReport {
  id: string
  targetKind: 'work' | 'user'
  targetId: string
  targetTitle: string
  reason: string
  details: string
  status: 'open' | 'resolved'
  resolution: string
  createdAt: number
}

// ---------------------------------------------------------------- addresses
export type NetworkRoute =
  | { page: 'discover' }
  | { page: 'mine' }
  | { page: 'requests' }
  | { page: 'profile' }
  | { page: 'admin' }
  | { page: 'work'; id: string }
  | { page: 'person'; id: string }
  | { page: 'org'; id: string }

export function routeFromPath(path: string): NetworkRoute | null {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts[0] !== 'network') return null
  const [, section, id] = parts
  if (!section) return { page: 'discover' }
  if (section === 'works' && id) return { page: 'work', id }
  if (section === 'people' && id) return { page: 'person', id }
  if (section === 'orgs' && id) return { page: 'org', id }
  if (section === 'mine' || section === 'requests' || section === 'profile' || section === 'admin') return { page: section }
  return { page: 'discover' }
}

export function pathForRoute(route: NetworkRoute): string {
  switch (route.page) {
    case 'discover':
      return '/network'
    case 'work':
      return `/network/works/${route.id}`
    case 'person':
      return `/network/people/${route.id}`
    case 'org':
      return `/network/orgs/${route.id}`
    default:
      return `/network/${route.page}`
  }
}

/** Pages people may open from a shared link without an account */
export const isPublicRoute = (route: NetworkRoute | null) => !!route && (route.page === 'work' || route.page === 'person' || route.page === 'org')

export const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
export const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
export const orcidUrl = (orcid: string, base = 'https://orcid.org') => `${base}/${orcid}`
