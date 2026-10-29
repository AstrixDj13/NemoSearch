import type { SavedReport } from './data'

// Conversational openers that add nothing to a title
const FILLER = [
  /^(please|hey|hi|ok|okay)\b[,\s]*/i,
  /^(can|could|would|will) you\s+/i,
  /^(tell|show|give|teach) me\s+(about\s+|on\s+)?/i,
  /^(i want to know|i'd like to know|i need to know|help me understand|what do you know)\s+(about\s+)?/i,
  /^(research|explain|summari[sz]e|describe|look up|search for|find)\s+/i,
  /^(the|a|an)\s+/i,
]

const ACRONYMS = ['AI', 'API', 'EV', 'GPU', 'HCI', 'LLM', 'LLMs', 'ML', 'MoE', 'NLP', 'PDF', 'RAG', 'SEC', 'UI', 'UX', 'VR', 'AR']
const ACRONYM_LOOKUP = new Map(ACRONYMS.map((a) => [a.toLowerCase(), a]))

const MAX_TITLE = 64

/** A short, readable title from a research question. The question itself is kept separately. */
export function makeTitle(question: string): string {
  let title = question.trim().replace(/\s+/g, ' ')
  for (let pass = 0; pass < 3; pass++) {
    for (const pattern of FILLER) title = title.replace(pattern, '')
  }
  title = title.replace(/[?.!\s]+$/, '')
  title = title.replace(/\b[\w']+\b/g, (word) => ACRONYM_LOOKUP.get(word.toLowerCase()) ?? word)
  if (!title) return question.trim()
  title = title.charAt(0).toUpperCase() + title.slice(1)
  if (title.length > MAX_TITLE) {
    const cut = title.slice(0, MAX_TITLE)
    title = `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : MAX_TITLE).replace(/[,;:\s]+$/, '')}…`
  }
  return title
}

const DAY = 24 * 60 * 60 * 1000

/** Compact relative time: Just now, 5m ago, 2h ago, Yesterday, Mon, Oct 22. */
export function relativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  const then = new Date(timestamp)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  if (then >= today) return `${Math.floor(diff / 3_600_000)}h ago`
  if (then.getTime() >= today.getTime() - DAY) return 'Yesterday'
  if (then.getTime() >= today.getTime() - 6 * DAY) return then.toLocaleDateString(undefined, { weekday: 'short' })
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const reportTime = (report: SavedReport, now: number) =>
  report.createdAt ? relativeTime(report.createdAt, now) : report.time

/** Brings reports saved by older versions (raw question as title, no metadata) up to date. */
export function normalizeReports(reports: SavedReport[]): SavedReport[] {
  return reports.map((report) => {
    if (report.question) return report
    // Old saves froze their label at "Just now"; without a real timestamp, don't claim recency
    const time = !report.createdAt && report.time === 'Just now' ? 'Earlier' : report.time
    return { ...report, question: report.title, title: makeTitle(report.title), time }
  })
}

/** Run number for reports sharing a title (oldest is Run 1), so identical titles stay distinguishable. */
export function runNumbers(reports: SavedReport[]): Map<string, number> {
  const groups = new Map<string, SavedReport[]>()
  for (const report of reports) {
    const key = report.title.trim().toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), report])
  }
  const numbers = new Map<string, number>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    ;[...group].reverse().forEach((report, i) => numbers.set(report.id, i + 1))
  }
  return numbers
}

/** Newest first; undated (seed) reports keep their order after dated ones. */
export const byRecency = (a: SavedReport, b: SavedReport) => (b.createdAt ?? 0) - (a.createdAt ?? 0)

/** Address of an open project in the Library, e.g. /library/projects/p_abc. */
export const projectPath = (projectId: string) => `/library/projects/${encodeURIComponent(projectId)}`

export function projectIdFromPath(path: string): string | null {
  const match = /^\/library\/projects\/([^/]+)\/?$/.exec(path)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null // a mangled link; open the app normally
  }
}
