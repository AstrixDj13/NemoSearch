// Client for the NemoSearch server's persistence API (projects and research history).
import type { AttachmentRecord, Project, ProjectDetail, SavedReport, SavedSourceRecord, Source } from './data'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new Error("Couldn't reach the NemoSearch server.")
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    // FastAPI's bare "Not Found" means the route itself is missing: an older server is still running
    if (res.status === 404 && body?.detail === 'Not Found') {
      throw new Error('The NemoSearch server is running an older version without saved history. Restart the server to load it.')
    }
    throw new Error(body?.detail || `The server answered ${res.status}.`)
  }
  return res.json() as Promise<T>
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  createProject: (name: string, description = '') => request<ProjectDetail>('/api/projects', json('POST', { name, description })),
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'notes' | 'archived'>>) =>
    request<ProjectDetail>(`/api/projects/${id}`, json('PATCH', patch)),
  deleteProject: (id: string, reports: 'unassign' | 'delete') =>
    request<{ movedReports: number; deletedReports: number }>(`/api/projects/${id}?reports=${reports}`, json('DELETE')),

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

  uploadAttachment: (projectId: string, file: File) =>
    request<AttachmentRecord>(`/api/projects/${projectId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }),
  deleteAttachment: (id: string) => request<{ ok: boolean }>(`/api/attachments/${id}`, json('DELETE')),

  recordExport: (projectId: string | null, reportId: string | null, kind: string, filename: string, content?: string) =>
    request<{ id: string }>('/api/exports', json('POST', { projectId, reportId, kind, filename, content })),
}
