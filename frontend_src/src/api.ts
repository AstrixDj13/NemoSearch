// Client for the NemoSearch server: accounts, private research (projects and history) and the Network.
import type {
  AttachmentRecord, PaperDoc, PaperSummary, Project, ProjectDetail, ProjectMember, ProjectMessage, SavedReport, SavedSourceRecord, Source,
} from './data'
import type {
  AbuseReport, AuthConfig, Me, NetworkNotification, NetworkRequest, Organization, Person, PublicUser, RequestKind,
  Visibility, WorkDetail, WorkSummary,
} from './network'

/** Fired when the server says the session ended, so the app can show the sign-in page */
export const SIGNED_OUT_EVENT = 'nemosearch:signed-out'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new Error("Couldn't reach the NemoSearch server.")
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    if (res.status === 401) {
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
      throw new Error('Your session ended. Sign in again to continue.')
    }
    // FastAPI's bare "Not Found" means the route itself is missing: an older server is still running
    if (res.status === 404 && body?.detail === 'Not Found') {
      throw new Error('The NemoSearch server is running an older version. Restart the server to load it.')
    }
    if (res.status === 404) throw new Error("That doesn't exist, or you don't have access to it.")
    throw new Error(body?.detail || `The server answered ${res.status}.`)
  }
  return res.json() as Promise<T>
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

const fileBody = (file: File, extra: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), ...extra },
  body: file,
})

export const api = {
  // ---------------- accounts
  authConfig: () => request<AuthConfig>('/api/auth/config'),
  me: () => request<Me>('/api/me'),
  updateMe: (patch: Partial<Pick<Me, 'name' | 'affiliation' | 'bio' | 'interests' | 'notifyEmail'>>) => request<Me>('/api/me', json('PATCH', patch)),
  devLogin: (name: string, orcid: string) => request<{ ok: boolean }>('/api/auth/dev-login', json('POST', { name, orcid })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', json('POST')),
  deleteAccount: () => request<{ ok: boolean }>('/api/me', json('DELETE', { confirm: 'DELETE' })),

  // ---------------- projects and history
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  createProject: (name: string, description = '') => request<ProjectDetail>('/api/projects', json('POST', { name, description })),
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'notes' | 'archived'>>) =>
    request<ProjectDetail>(`/api/projects/${id}`, json('PATCH', patch)),
  deleteProject: (id: string, reports: 'unassign' | 'delete') =>
    request<{ movedReports: number; deletedReports: number }>(`/api/projects/${id}?reports=${reports}`, json('DELETE')),
  addMember: (projectId: string, orcid: string) => request<ProjectMember[]>(`/api/projects/${projectId}/members`, json('POST', { orcid })),
  removeMember: (projectId: string, userId: string) => request<{ ok: boolean }>(`/api/projects/${projectId}/members/${userId}`, json('DELETE')),
  listMessages: (projectId: string, after?: number) =>
    request<ProjectMessage[]>(`/api/projects/${projectId}/messages${after === undefined ? '' : `?after=${after}`}`),
  postMessage: (projectId: string, body: string) => request<ProjectMessage>(`/api/projects/${projectId}/messages`, json('POST', { body })),

  listReports: (project = 'all') => request<SavedReport[]>(`/api/reports?project=${encodeURIComponent(project)}`),
  getReport: (id: string) => request<SavedReport>(`/api/reports/${id}`),
  importReports: (reports: SavedReport[]) => request<{ imported: number }>('/api/reports/import', json('POST', reports)),
  updateReport: (id: string, patch: { title?: string; archived?: boolean }) =>
    request<SavedReport>(`/api/reports/${id}`, json('PATCH', patch)),
  duplicateReport: (id: string) => request<SavedReport>(`/api/reports/${id}/duplicate`, json('POST')),
  deleteReport: (id: string) => request<{ ok: boolean }>(`/api/reports/${id}`, json('DELETE')),
  restoreReport: (id: string) => request<{ ok: boolean }>(`/api/reports/${id}/restore`, json('POST')),

  listSources: (project: string) => request<SavedSourceRecord[]>(`/api/sources?project=${encodeURIComponent(project)}`),
  saveSource: (projectId: string | null, reportId: string | null, source: Source) =>
    request<SavedSourceRecord>('/api/sources', json('POST', { projectId, reportId, source })),
  deleteSource: (id: string) => request<{ ok: boolean }>(`/api/sources/${id}`, json('DELETE')),

  uploadAttachment: (projectId: string, file: File) => request<AttachmentRecord>(`/api/projects/${projectId}/attachments`, fileBody(file)),
  deleteAttachment: (id: string) => request<{ ok: boolean }>(`/api/attachments/${id}`, json('DELETE')),

  recordExport: (projectId: string | null, reportId: string | null, kind: string, filename: string, content?: string) =>
    request<{ id: string }>('/api/exports', json('POST', { projectId, reportId, kind, filename, content })),

  // ---------------- Paper Studio
  listPapers: () => request<PaperSummary[]>('/api/papers'),
  openPaper: (reportId: string, templateId: string) => request<PaperDoc>('/api/papers', json('POST', { reportId, templateId })),
  getPaper: (id: string, after?: number) => request<PaperDoc>(`/api/papers/${id}${after === undefined ? '' : `?after=${after}`}`),
  draftPaper: (id: string, templateId: string) => request<PaperDoc>(`/api/papers/${id}/draft`, json('POST', { templateId })),
  sendPaperMessage: (id: string, body: string) => request<PaperDoc>(`/api/papers/${id}/messages`, json('POST', { body })),
  editPaper: (id: string, baseVersion: number, patch: { latex?: string; bibtex?: string; templateId?: string }) =>
    request<PaperDoc>(`/api/papers/${id}`, json('PATCH', { baseVersion, ...patch })),
}

export const networkApi = {
  discover: (q: string, tag = '', offset = 0) =>
    request<{ total: number; items: WorkSummary[] }>(`/api/network/works?${new URLSearchParams({ q, tag, offset: String(offset) })}`),
  related: (q: string) => request<WorkSummary[]>(`/api/network/related?${new URLSearchParams({ q })}`),
  mine: () => request<WorkSummary[]>('/api/network/works/mine'),
  shared: () => request<WorkSummary[]>('/api/network/works/shared'),
  work: (id: string) => request<WorkDetail>(`/api/network/works/${id}`),
  createWork: (body: { title: string; abstract: string; authors: string[]; tags: string[]; license: string; orgId?: string | null; reportId?: string }) =>
    request<WorkDetail>('/api/network/works', json('POST', body)),
  updateWork: (id: string, patch: Partial<{ title: string; abstract: string; authors: string[]; tags: string[]; license: string; visibility: Visibility; orgId: string | null; confirmRights: boolean }>) =>
    request<WorkDetail>(`/api/network/works/${id}`, json('PATCH', patch)),
  deleteWork: (id: string) => request<{ ok: boolean }>(`/api/network/works/${id}`, json('DELETE')),
  uploadVersion: (id: string, file: File, note = '') =>
    request<WorkDetail>(`/api/network/works/${id}/versions`, fileBody(file, { 'X-Version-Note': encodeURIComponent(note) })),
  downloadUrl: (workId: string, versionId: string) => `/api/network/works/${workId}/versions/${versionId}/download`,
  grant: (id: string, orcid: string) => request<WorkDetail>(`/api/network/works/${id}/access`, json('POST', { orcid })),
  revoke: (id: string, userId: string) => request<{ ok: boolean }>(`/api/network/works/${id}/access/${userId}`, json('DELETE')),

  sendRequest: (workId: string, kind: RequestKind, message: string) =>
    request<NetworkRequest>(`/api/network/works/${workId}/requests`, json('POST', { kind, message })),
  requests: (box: 'incoming' | 'outgoing') => request<NetworkRequest[]>(`/api/network/requests?box=${box}`),
  accept: (id: string, response: string, projectId?: string) =>
    request<NetworkRequest>(`/api/network/requests/${id}/accept`, json('POST', { response, projectId: projectId || null })),
  decline: (id: string, response: string) => request<NetworkRequest>(`/api/network/requests/${id}/decline`, json('POST', { response })),
  withdraw: (id: string) => request<NetworkRequest>(`/api/network/requests/${id}/withdraw`, json('POST')),
  notifications: () => request<NetworkNotification[]>('/api/network/notifications'),
  markRead: () => request<{ ok: boolean }>('/api/network/notifications/read', json('POST')),

  people: (q: string) => request<PublicUser[]>(`/api/network/people?${new URLSearchParams({ q })}`),
  person: (id: string) => request<Person>(`/api/network/people/${id}`),
  block: (id: string, on: boolean) => request<{ ok: boolean }>(`/api/network/people/${id}/block`, json(on ? 'POST' : 'DELETE')),

  createOrg: (body: { name: string; rorId?: string; website?: string; description?: string }) =>
    request<Organization>('/api/network/orgs', json('POST', body)),
  org: (id: string) => request<Organization>(`/api/network/orgs/${id}`),
  updateOrg: (id: string, body: { name?: string; rorId?: string; website?: string; description?: string }) =>
    request<Organization>(`/api/network/orgs/${id}`, json('PATCH', body)),
  addOrgMember: (id: string, orcid: string, role: 'admin' | 'member') =>
    request<Organization>(`/api/network/orgs/${id}/members`, json('POST', { orcid, role })),
  removeOrgMember: (id: string, userId: string) => request<Organization>(`/api/network/orgs/${id}/members/${userId}`, json('DELETE')),

  claim: (doi: string) => request<WorkDetail>('/api/network/claims', json('POST', { doi })),
  reportAbuse: (targetKind: 'work' | 'user', targetId: string, reason: string, details: string) =>
    request<{ ok: boolean }>('/api/network/abuse', json('POST', { targetKind, targetId, reason, details })),
  verifyChain: () => request<{ ok: boolean; records: number; head?: string; brokenAt?: string }>('/api/network/ownership/verify'),

  adminAbuse: (status: 'open' | 'resolved') => request<AbuseReport[]>(`/api/network/admin/abuse?status=${status}`),
  adminResolve: (id: string, resolution: string) => request<{ ok: boolean }>(`/api/network/admin/abuse/${id}/resolve`, json('POST', { resolution })),
  adminTakedown: (workId: string, down: boolean, reason: string) =>
    request<WorkDetail>(`/api/network/admin/works/${workId}/takedown`, json('POST', { down, reason })),
  adminVerifyOrg: (orgId: string, verified: boolean) => request<Organization>(`/api/network/admin/orgs/${orgId}/verify`, json('POST', { verified })),
}
