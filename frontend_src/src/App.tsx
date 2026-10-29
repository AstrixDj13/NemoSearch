import { useEffect, useRef, useState, useMemo } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  BookmarkX,
  BrainCircuit,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderPlus,
  Globe2,
  GraduationCap,
  Library,
  LoaderCircle,
  LogOut,
  Menu,
  Network as NetworkIcon,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Pencil,
  Plus,
  Presentation,
  ScanSearch,
  Search,
  Share2,
  Trash2,
  ShieldCheck,
  Upload,
  UserRound,
  Users,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import DotField from './components/DotField'
import Logo from './components/Logo'
import DeleteProjectDialog from './components/DeleteProjectDialog'
import ItemMenu from './components/ItemMenu'
import ProjectDialog from './components/ProjectDialog'
import ProjectWorkspace from './components/ProjectWorkspace'
import CollaborationHeader from './components/CollaborationHeader'
import { api, networkApi } from './api'
import NetworkView from './components/network/NetworkView'
import { PublishDialog } from './components/network/dialogs'
import { pathForRoute, routeFromPath } from './network'
import type { Me, NetworkRoute, WorkSummary } from './network'
import RoutingEditor from './components/RoutingEditor'
import { CoverageLog, CoverageNotice, SourceKind, SourceProvenance } from './components/SourceProvenance'
import { isPaper, sourceOrigin } from './sources'
import { byRecency, makeTitle, normalizeReports, projectIdFromPath, projectPath, relativeTime, reportTime, runNumbers } from './library'
import PaperStudio from './components/PaperStudio'
import StudioFileTree from './components/StudioFileTree'
import {
  defaultResearchSteps,
  sampleSources,
  SAMPLE_QUERY,
} from './data'
import type { FocusMode, Project, ResearchScope, RunCoverage, SavedReport, SlideItem, Source, View } from './data'
import {
  fallbackPresets,
  loadRouting,
  modelLabel,
  presetInfo,
  routingModels,
  storeRouting,
} from './routing'
import type { Preset, Routing, RoutingScope, TeamModels } from './routing'
import './App.css'

const focusOptions: { id: FocusMode; label: string; icon: typeof Globe2 }[] = [
  { id: 'web', label: 'All web', icon: Globe2 },
  { id: 'academic', label: 'Academic', icon: GraduationCap },
  { id: 'finance', label: 'Finance & SEC', icon: ChartNoAxesCombined },
  { id: 'news', label: 'Recent news', icon: Newspaper },
]

const stepIcons = [BrainCircuit, ScanSearch, BookOpen, ShieldCheck, PenLine]

const defaultSlides: SlideItem[] = [
  { num: '01', title: 'The decision', bullets: ['Dense vs. sparse inference in one operational frame.'] },
  { num: '02', title: 'Why sparse scaling matters', bullets: ['Capacity, active parameters, and conditional compute.'] },
  { num: '03', title: 'The serving constraint', bullets: ['Routing, memory pressure, and real-world utilization.'] },
  { num: '04', title: 'Beyond the architecture', bullets: ['IO-aware kernels and the complete serving system.'] },
  { num: '05', title: 'Recommendation', bullets: ['Benchmark the workload, not the parameter count.'] },
]

// Shapes of the payloads sent by the FastAPI backend
interface BackendSource {
  id: number
  title?: string
  url?: string
  domain?: string
  quote?: string
  summary?: string
  snippet?: string
  relevance?: number
  kind?: Source['kind']
  access?: Source['access']
  provider?: string
  query?: string
  retrieved_at?: string
  paper?: Source['paper']
  fulltext?: Source['fulltext']
}

interface FollowUpTurn {
  question: string
  answer: string
  status: 'streaming' | 'done' | 'error'
  /** Progress or problem text shown under the answer */
  note?: string
}

interface BackendSlide {
  title?: string
  bullets?: string[]
}

const toSource = (s: BackendSource, fallbackRelevance = 85): Source => ({
  id: s.id,
  title: s.title || 'Untitled source',
  authors: s.paper ? s.paper.authors.join(', ') : s.domain || 'Web source',
  domain: s.domain || 'web',
  url: s.url || '#',
  relevance: typeof s.relevance === 'number' ? Math.round(s.relevance * 10) : fallbackRelevance,
  quote: s.quote || s.snippet || s.summary || '',
  summary: s.summary,
  snippet: s.snippet,
  kind: s.kind,
  access: s.access,
  provider: s.provider,
  query: s.query,
  retrieved_at: s.retrieved_at,
  paper: s.paper,
  fulltext: s.fulltext,
})

function IconButton({ label, children, onClick, className = '' }: { label: string; children: ReactNode; onClick: () => void; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick}>{children}</button>
}

function Citation({ id, source, onOpen }: { id: number; source?: Source; onOpen: (source: Source) => void }) {
  if (!source) {
    return (
      <span className="citation unverified" title="No retrieved source has this number">
        [{id}]<span className="visually-hidden"> (unverified: no retrieved source has this number)</span>
      </span>
    )
  }
  return (
    <span className="citation-wrap">
      <button type="button" className="citation" onClick={() => onOpen(source)} aria-label={`Verify source ${id}: ${source.title}`}>[{id}]</button>
      <span className="citation-hover" role="tooltip">
        <span className="citation-hover-top"><span>{isPaper(source) ? `Paper · ${sourceOrigin(source)}` : source.domain}</span><span>{source.relevance}% match</span></span>
        <strong>{source.title}</strong>
        <span className="citation-quote">“{source.quote || source.summary || source.snippet}”</span>
        <span className="citation-verify"><Check size={13} /> Click to inspect evidence</span>
      </span>
    </span>
  )
}

// Inline markdown: citations [1] / [1, 4], links, bold, italics and inline code
const INLINE_TOKEN =
  /(\[\d+(?:\s*,\s*\d+)*\](?!\()|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w))/g

function InlineContent({ text, sourceMap, onOpenSource }: { text: string; sourceMap: Map<number, Source>; onOpenSource: (s: Source) => void }) {
  const renderInline = (value: string, keyPrefix: string): ReactNode[] =>
    value.split(INLINE_TOKEN).map((part, idx) => {
      const key = `${keyPrefix}-${idx}`
      if (!part) return null
      const cite = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/)
      if (cite) {
        return cite[1].split(',').map((n) => {
          const id = parseInt(n.trim(), 10)
          return <Citation key={`${key}-${id}`} id={id} source={sourceMap.get(id)} onOpen={onOpenSource} />
        })
      }
      const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
      if (link) {
        const safe = /^https?:\/\//i.test(link[2])
        return safe ? (
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">{renderInline(link[1], key)}</a>
        ) : (
          <span key={key}>{renderInline(link[1], key)}</span>
        )
      }
      if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
        return <strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>
      }
      if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>
      if (part.length > 2 && ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))) {
        return <em key={key}>{renderInline(part.slice(1, -1), key)}</em>
      }
      return part
    })

  // Stray heading markers inside bullets or snippets are noise, not structure
  return <>{renderInline(text.replace(/(^|\s)#{1,6}\s+/g, '$1'), 'i')}</>
}

type ReportBlock =
  | { type: 'summary'; items: string[] }
  | { type: 'heading'; level: 2 | 3; title: string }
  | { type: 'p'; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'conclusion'; blocks: ReportBlock[] }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/
const BULLET = /^[-*+]\s+/
const ORDERED = /^\d+[.)]\s+/
const RULE = /^([-*_])(\s*\1){2,}$/
const isTableRow = (line: string) => line.startsWith('|') && line.endsWith('|') && line.length > 1
const isTableDivider = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)
const tableCells = (line: string) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const stripHeading = (text: string) => text.replace(/\*\*/g, '').trim()

function parseReportBlocks(lines: string[]): ReportBlock[] {
  const blocks: ReportBlock[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim()
    if (text) blocks.push({ type: 'p', content: text })
    paragraph = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    const heading = line.match(HEADING)
    const lower = line.toLowerCase()

    if (/^(\*\*tl;dr:?\*\*:?|#{1,6}\s+tl;dr:?)$/.test(lower)) {
      flushParagraph()
      i++
      while (i < lines.length && !lines[i].trim()) i++
      const items: string[] = []
      while (i < lines.length && (BULLET.test(lines[i].trim()) || ORDERED.test(lines[i].trim()))) {
        items.push(lines[i].trim().replace(BULLET, '').replace(ORDERED, ''))
        i++
      }
      blocks.push({ type: 'summary', items })
      continue
    }

    if (heading) {
      flushParagraph()
      const level = heading[1].length
      const title = stripHeading(heading[2])
      i++
      // The report title is already shown in the page header
      if (level === 1) continue
      if (level === 2 && /bottom line|conclusion/i.test(title)) {
        const body: string[] = []
        while (i < lines.length && !/^#{1,2}\s/.test(lines[i].trim())) body.push(lines[i++])
        blocks.push({ type: 'conclusion', blocks: parseReportBlocks(body) })
        continue
      }
      blocks.push({ type: 'heading', level: level === 2 ? 2 : 3, title })
      continue
    }

    if (RULE.test(line)) {
      flushParagraph()
      i++
      continue
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1].trim())) {
      flushParagraph()
      const header = tableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i].trim())) rows.push(tableCells(lines[i++].trim()))
      blocks.push({ type: 'table', header, rows })
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph()
      const ordered = ORDERED.test(line)
      const marker = ordered ? ORDERED : BULLET
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].trim()
        if (marker.test(item)) {
          items.push(item.replace(marker, ''))
        } else if (BULLET.test(item) || ORDERED.test(item)) {
          // Nested item of the other kind: keep it inside the current list
          items.push(item.replace(BULLET, '').replace(ORDERED, ''))
        } else if (item && !HEADING.test(item) && !isTableRow(item) && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${item}`
        } else {
          break
        }
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    if (line.startsWith('>')) {
      flushParagraph()
      const quote: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''))
      blocks.push({ type: 'quote', content: quote.join(' ') })
      continue
    }

    if (line === '') flushParagraph()
    else paragraph.push(line)
    i++
  }
  flushParagraph()
  return blocks
}

function RenderReportBody({
  markdown,
  sources,
  onOpenSource,
}: {
  markdown: string
  sources: Source[]
  onOpenSource: (source: Source) => void
}) {
  const sourceMap = useMemo(() => {
    const map = new Map<number, Source>()
    sources.forEach((s) => map.set(s.id, s))
    return map
  }, [sources])

  const blocks = useMemo(() => (markdown ? parseReportBlocks(markdown.split('\n')) : []), [markdown])

  const inline = (text: string) => <InlineContent text={text} sourceMap={sourceMap} onOpenSource={onOpenSource} />

  const renderBlock = (block: ReportBlock, idx: number): ReactNode => {
    switch (block.type) {
      case 'summary':
        return (
          <section className="answer-summary" key={idx}>
            <div className="section-label">The short answer</div>
            <div style={{ marginTop: '14px', display: 'grid', gap: '8px' }}>
              {block.items.map((it, iIdx) => (
                <p key={iIdx} style={{ margin: 0 }}>
                  • {inline(it)}
                </p>
              ))}
            </div>
          </section>
        )
      case 'heading':
        return block.level === 2 ? (
          <h2 key={idx} style={{ marginTop: '32px' }}>{inline(block.title)}</h2>
        ) : (
          <h3 key={idx}>{inline(block.title)}</h3>
        )
      case 'list': {
        const ListTag = block.ordered ? 'ol' : 'ul'
        return (
          <ListTag key={idx} className="report-list">
            {block.items.map((it, lIdx) => (
              <li key={lIdx}>{inline(it)}</li>
            ))}
          </ListTag>
        )
      }
      case 'quote':
        return <blockquote key={idx}>{inline(block.content)}</blockquote>
      case 'table':
        return (
          <div className="report-table-wrap" key={idx}>
            <table>
              <thead>
                <tr>{block.header.map((cell, cIdx) => <th key={cIdx}>{inline(cell)}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, rIdx) => (
                  <tr key={rIdx}>{row.map((cell, cIdx) => <td key={cIdx}>{inline(cell)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'conclusion':
        return (
          <div className="report-conclusion" key={idx} style={{ marginTop: '32px' }}>
            <span className="section-label">Bottom line</span>
            {block.blocks.map(renderBlock)}
          </div>
        )
      default:
        return <p key={idx}>{inline(block.content)}</p>
    }
  }

  return <article className="report-article">{blocks.map(renderBlock)}</article>
}

interface AppProps {
  me: Me
  orcidBase: string
  /** Reloads the account (badge counts, organizations) */
  refreshMe: () => void
}

export default function App({ me, orcidBase, refreshMe }: AppProps) {
  const [view, setView] = useState<View>(() =>
    routeFromPath(window.location.pathname) ? 'network' : projectIdFromPath(window.location.pathname) ? 'library' : 'home'
  )
  const [networkRoute, setNetworkRoute] = useState<NetworkRoute>(() => routeFromPath(window.location.pathname) ?? { page: 'discover' })
  const [publishing, setPublishing] = useState<{ reportId?: string } | null>(null)
  const [relatedWorks, setRelatedWorks] = useState<WorkSummary[]>([])
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState(SAMPLE_QUERY)
  const [focusMode] = useState<FocusMode>('web')
  const [deepMode, setDeepMode] = useState(true)
  const [runStep, setRunStep] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('nemosearch_sidebar_collapsed') === '1'
    } catch {
      return false
    }
  })
  const [reportTab, setReportTab] = useState<'brief' | 'sources' | 'reasoning'>('brief')
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  const [slidesOpen, setSlidesOpen] = useState(false)
  const [slidesLoading, setSlidesLoading] = useState(false)
  const [slidesData, setSlidesData] = useState<SlideItem[]>(defaultSlides)
  const [attachment, setAttachment] = useState('')
  const [toast, setToast] = useState('')
  const [toastAction, setToastAction] = useState<{ label: string; run: () => void } | null>(null)
  const [toastTone, setToastTone] = useState<'info' | 'error'>('info')
  const [libraryFilter, setLibraryFilter] = useState('')
  const [followUp, setFollowUp] = useState('')
  // The whole follow-up conversation for the open report, oldest turn first
  const [thread, setThread] = useState<FollowUpTurn[]>([])
  const [followUpSending, setFollowUpSending] = useState(false)

  // Live Research States
  const [liveSteps, setLiveSteps] = useState(defaultResearchSteps)
  const [liveSources, setLiveSources] = useState<Source[]>(sampleSources)
  const [runCoverage, setRunCoverage] = useState<RunCoverage | null>(null)
  const [runWarnings, setRunWarnings] = useState<string[]>([])
  // Research in a project is given the project's paper, description and notes unless this is switched off
  const [useProjectContext, setUseProjectContext] = useState(true)
  const [runContext, setRunContext] = useState<{ project: string; work: string | null } | null>(null)
  const [liveReport, setLiveReport] = useState<string>('')
  const [liveReasoning, setLiveReasoning] = useState<string>('')
  const [liveStats, setLiveStats] = useState<{ elapsed?: number; ttft?: number; nSources?: number; gaps?: string[] }>({})
  const [isLiveRun, setIsLiveRun] = useState(false)
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; provider?: string }>({ ok: true })

  // Research routing: the saved default, optionally overridden for the next run only
  const [presets, setPresets] = useState<Record<Preset, TeamModels>>(fallbackPresets)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [providerOptions, setProviderOptions] = useState<string[]>(['tavily', 'wikipedia'])
  const [savedRouting, setSavedRouting] = useState<Routing>(loadRouting)
  const [nextRunRouting, setNextRunRouting] = useState<Routing | null>(null)
  const [runModels, setRunModels] = useState<TeamModels | null>(null)
  const [routingOpen, setRoutingOpen] = useState(false)
  const routingOpener = useRef<HTMLElement | null>(null)
  const activeRouting = nextRunRouting ?? savedRouting
  const teamModels = routingModels(activeRouting, presets)
  const routingLabel = presetInfo[activeRouting.preset].label + (nextRunRouting ? ' · next run' : '')

  // Library persisted in localStorage
  // Research history and projects live on the NemoSearch server, not in the browser
  const [libraryReports, setLibraryReports] = useState<SavedReport[]>([])
  const [historyStatus, setHistoryStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [historyError, setHistoryError] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [scope, setScope] = useState<ResearchScope>(() => {
    // A project's own address wins over the remembered choice
    const fromPath = projectIdFromPath(window.location.pathname)
    if (fromPath) return fromPath
    try {
      return localStorage.getItem('nemosearch_scope') || 'all'
    } catch {
      return 'all'
    }
  })
  const [runProject, setRunProject] = useState(() => (scope !== 'all' && scope !== 'unassigned' ? scope : ''))
  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' | 'rename'; project?: Project; forRun?: boolean } | null>(null)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [workspaceKey, setWorkspaceKey] = useState(0)
  const [savedSourceIds, setSavedSourceIds] = useState<Record<string, string>>({})
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
  const dialogOpener = useRef<HTMLElement | null>(null)
  const [activeReportId, setActiveReportId] = useState<string | null>(null)
  // The Library page a report was opened from (which project, how far down), so the report can lead back to it
  const [reportReturn, setReportReturn] = useState<{ scope: ResearchScope; scrollY: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; place: 'sidebar' | 'library' } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
  // Re-renders relative timestamps ("5m ago") once a minute
  const [now, setNow] = useState(() => Date.now())

  const searchRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const activeEventSource = useRef<EventSource | null>(null)

  const notify = (message: string, action?: { label: string; run: () => void }, tone: 'info' | 'error' = 'info') => {
    setToast(message)
    setToastTone(tone)
    setToastAction(action ?? null)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      setToast('')
      setToastAction(null)
    }, action || tone === 'error' ? 7000 : 3200)
  }

  // Fetch health status on mount
  // Most-published research topics of the last 30 days (OpenAlex); one is shown as the input's example
  const [trendingTopics, setTrendingTopics] = useState<string[]>([])
  const [topicIndex, setTopicIndex] = useState(0)
  useEffect(() => {
    fetch('/api/trending-topics')
      .then((res) => res.json())
      .then((data) => {
        const names = Array.isArray(data.topics) ? data.topics.map((t: { name: string }) => t.name).filter(Boolean) : []
        setTrendingTopics(names)
        setTopicIndex(Math.floor(Math.random() * Math.max(1, names.length)))
      })
      .catch(() => setTrendingTopics([]))
  }, [])
  const exampleTopic = trendingTopics.length ? trendingTopics[topicIndex % trendingTopics.length] : ''

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => setHealthStatus({ ok: !!data.ok, provider: data.search_provider }))
      .catch(() => setHealthStatus({ ok: true, provider: 'tavily' }))
    fetch('/api/models')
      .then((res) => res.json())
      .then((data) => {
        if (data.presets) {
          setPresets({
            fast: { ...fallbackPresets.fast, ...data.presets.fast },
            balanced: { ...fallbackPresets.balanced, ...data.presets.balanced },
            thorough: { ...fallbackPresets.thorough, ...data.presets.thorough },
          })
        }
        if (Array.isArray(data.models)) setModelOptions(data.models)
        setCatalogStatus('ready')
        if (Array.isArray(data.search_providers)) setProviderOptions(data.search_providers)
      })
      .catch(() => {
        // Keep the built-in presets; the editor explains that other models can't be listed
        setCatalogStatus('error')
      })
  }, [])


  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setView('home')
        window.setTimeout(() => searchRef.current?.focus(), 50)
      }
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        setSelectedSource(null)
        setSlidesOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Live timer during 'running' view
  useEffect(() => {
    if (view !== 'running') return
    const timer = window.setInterval(() => {
      setElapsedTime((prev) => prev + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [view])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    if (view !== 'report' || !isLiveRun || !submittedQuery) return
    let cancelled = false
    networkApi
      .related(submittedQuery)
      .then((works) => !cancelled && setRelatedWorks(works.filter((w) => w.owner?.id !== me.id)))
      .catch(() => !cancelled && setRelatedWorks([]))
    return () => {
      cancelled = true
    }
  }, [view, isLiveRun, submittedQuery, me.id])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const loadHistory = async () => {
    setHistoryStatus('loading')
    try {
      // One-time move of history the browser kept before server persistence existed
      const legacy = localStorage.getItem('nemosearch_library')
      if (legacy) {
        await api.importReports(normalizeReports(JSON.parse(legacy)))
        localStorage.removeItem('nemosearch_library')
      }
    } catch {
      // Leave the old copy in place; the import is retried on the next load
    }
    try {
      const [reports, projectList] = await Promise.all([api.listReports('all'), api.listProjects()])
      setLibraryReports(reports)
      setProjects(projectList)
      // A project you were removed from, or a link to one you can't open, falls back to the whole Library
      setScope((s) => (s === 'all' || s === 'unassigned' || projectList.some((p) => p.id === s) ? s : 'all'))
      setHistoryStatus('ready')
    } catch (e) {
      setHistoryError((e as Error).message)
      setHistoryStatus('error')
    }
  }

  useEffect(() => {
    loadHistory()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('nemosearch_scope', scope)
    } catch {
      // View preference only
    }
  }, [scope])

  const refreshProjects = () => {
    api.listProjects().then(setProjects).catch(() => undefined)
    setWorkspaceKey((key) => key + 1)
  }

  // Network pages have real addresses so works and profiles can be shared; the rest of the app lives at /
  const navigateNetwork = (route: NetworkRoute) => {
    const path = pathForRoute(route)
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
    setNetworkRoute(route)
    setView('network')
    setSidebarOpen(false)
    window.scrollTo(0, 0)
  }

  useEffect(() => {
    const onPop = () => {
      const route = routeFromPath(window.location.pathname)
      const projectId = projectIdFromPath(window.location.pathname)
      if (route) {
        setNetworkRoute(route)
        setView('network')
      } else if (projectId) {
        changeScopeRef.current(projectId)
        setView('library')
      } else {
        setView((current) => (current === 'network' ? 'home' : current))
        // Back from a project lands on the whole Library
        setScope((s) => (s === 'all' || s === 'unassigned' ? s : 'all'))
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // An open project has its own address (so Back, refresh and links work); every other non-Network view lives at /
  useEffect(() => {
    if (view === 'network') return
    const path = view === 'library' && scope !== 'all' && scope !== 'unassigned' ? projectPath(scope) : '/'
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
  }, [view, scope])

  const navigate = (nextView: View) => {
    if (nextView === 'network') return navigateNetwork(networkRoute)
    if (nextView === 'home' && view !== 'home') setTopicIndex((i) => i + 1)
    setView(nextView)
    setSidebarOpen(false)
    if (nextView === 'home') window.setTimeout(() => searchRef.current?.focus(), 50)
  }

  const newResearch = () => {
    if (activeEventSource.current) {
      activeEventSource.current.close()
      activeEventSource.current = null
    }
    setQuery('')
    setAttachment('')
    setAttachmentFile(null)
    setActiveReportId(null)
    setThread([])
    setRunStep(0)
    navigate('home')
  }

  const stopResearch = () => {
    if (activeEventSource.current) {
      activeEventSource.current.close()
      activeEventSource.current = null
    }
    setView('home')
    setRunStep(0)
    notify('Research run stopped.')
  }

  const startResearch = (value = query) => {
    const cleanQuery = value.trim()
    if (!cleanQuery) {
      notify('Add a research question to begin.')
      searchRef.current?.focus()
      return
    }

    if (activeEventSource.current) {
      activeEventSource.current.close()
      activeEventSource.current = null
    }

    setSubmittedQuery(cleanQuery)
    setActiveReportId(null)
    setRunStep(0)
    setElapsedTime(1)
    setThread([])
    setSidebarOpen(false)
    setIsLiveRun(true)
    setLiveReport('')
    setLiveReasoning('')
    setLiveSources([])
    setRunCoverage(null)
    setRunWarnings([])
    setRunContext(null)
    setLiveSteps([
      { name: 'Planner', model: modelLabel(teamModels.planner), detail: 'Decomposing question into research paths...' },
      { name: 'Scout', model: modelLabel(teamModels.scout), detail: 'Preparing live search across primary sources...' },
      { name: 'Readers', model: modelLabel(teamModels.reader), detail: 'Standing by for parallel evidence extraction...' },
      { name: 'Critic', model: modelLabel(teamModels.critic), detail: 'Queued to verify coverage & close gaps...' },
      { name: 'Lead analyst', model: modelLabel(teamModels.writer), detail: 'Queued for rigorous cited synthesis...' },
    ])
    setReportReturn(null) // a new run was not opened from the Library
    setView('running')

    // Connect to real FastAPI SSE endpoint
    const params = new URLSearchParams({
      q: cleanQuery,
      depth: deepMode ? 'deep' : 'quick',
      focus: focusMode,
      title: makeTitle(cleanQuery),
      ...(runProject ? { project_id: runProject, use_context: useProjectContext ? 'true' : 'false' } : {}),
      ...routingParams(teamModels, activeRouting.preset),
    })
    if (attachmentFile) {
      if (runProject) {
        api
          .uploadAttachment(runProject, attachmentFile)
          .then(() => refreshProjects())
          .catch((e: Error) => notify(`Couldn't attach “${attachmentFile.name}”: ${e.message}`, undefined, 'error'))
      } else {
        notify(`“${attachmentFile.name}” wasn't kept: files are stored inside projects. Choose a project to keep attachments.`, undefined, 'error')
      }
      setAttachment('')
      setAttachmentFile(null)
    }
    // Follow-ups and slides for this run keep the models it ran with
    setRunModels(teamModels)
    setNextRunRouting(null)
    const url = `/api/research?${params}`
    let accumulatedReport = ''
    let accumulatedReasoning = ''
    let collectedSources: Source[] = []
    let finished = false

    try {
      const es = new EventSource(url)
      activeEventSource.current = es

      // Backend closes every stream with a named `end` event; without a `done` the run failed
      es.addEventListener('end', () => {
        es.close()
        activeEventSource.current = null
        if (finished) return
        if (accumulatedReport) {
          setRunStep(5)
          setView('report')
          setReportTab('brief')
        } else {
          setRunStep(0)
          setView('home')
        }
      })

      es.onmessage = (event) => {
        try {
          if (!event.data) return
          const data = JSON.parse(event.data)

          if (data.type === 'stage') {
            const stageName = data.agent
            const status = data.status
            const detail = data.detail || ''

            if (stageName === 'planner') {
              setRunStep((prev) => Math.max(prev, status === 'done' ? 1 : 0))
              setLiveSteps((steps) =>
                steps.map((s, i) => (i === 0 ? { ...s, detail: detail || s.detail } : s))
              )
            } else if (stageName === 'scout') {
              setRunStep((prev) => Math.max(prev, status === 'done' ? 2 : 1))
              setLiveSteps((steps) =>
                steps.map((s, i) => (i === 1 ? { ...s, detail: detail || s.detail } : s))
              )
            } else if (stageName === 'reader') {
              setRunStep((prev) => Math.max(prev, status === 'done' ? 3 : 2))
              setLiveSteps((steps) =>
                steps.map((s, i) => (i === 2 ? { ...s, detail: detail || s.detail } : s))
              )
            } else if (stageName === 'critic') {
              setRunStep((prev) => Math.max(prev, status === 'done' ? 4 : 3))
              setLiveSteps((steps) =>
                steps.map((s, i) => (i === 3 ? { ...s, detail: detail || s.detail } : s))
              )
            } else if (stageName === 'writer') {
              setRunStep((prev) => Math.max(prev, 4))
              setLiveSteps((steps) =>
                steps.map((s, i) => (i === 4 ? { ...s, detail: detail || s.detail } : s))
              )
            }
          } else if (data.type === 'source') {
            const src: BackendSource = data.source
            collectedSources = [...collectedSources, toSource({ ...src, relevance: undefined })]
            setLiveSources([...collectedSources])
          } else if (data.type === 'note') {
            collectedSources = collectedSources.map((s) => {
              if (s.id === data.id) {
                return {
                  ...s,
                  relevance: typeof data.relevance === 'number' ? Math.round(data.relevance * 10) : s.relevance,
                  quote: data.quote || s.quote,
                  summary: data.summary || s.summary,
                }
              }
              return s
            })
            setLiveSources([...collectedSources])
          } else if (data.type === 'think') {
            accumulatedReasoning += data.delta
            setLiveReasoning(accumulatedReasoning)
          } else if (data.type === 'report') {
            accumulatedReport += data.delta
            setLiveReport(accumulatedReport)
          } else if (data.type === 'done') {
            // Keep listening: the server sends `saved` (with the stored report's id) and then `end`
            finished = true
            setRunStep(5)
            setRunCoverage(data.coverage ?? null)
            setLiveStats({
              elapsed: data.elapsed,
              ttft: data.ttft_writer,
              nSources: data.n_sources,
            })

            // Finalize sources list if backend provided complete map
            if (data.sources) {
              const fullSources: Source[] = (Object.values(data.sources) as BackendSource[]).map((s) => toSource(s, 88))
              collectedSources = fullSources
              setLiveSources(fullSources)
            }

            // Switch to report view
            window.setTimeout(() => {
              setView('report')
              setReportTab('brief')
            }, 600)
          } else if (data.type === 'saved') {
            // The server stored the finished report (in its project, or Unassigned)
            const saved: SavedReport = data.report
            setLibraryReports((prev) => [saved, ...prev.filter((r) => r.id !== saved.id)])
            setActiveReportId(saved.id)
            loadSavedSources(saved.projectId ?? null)
            refreshProjects()
          } else if (data.type === 'context') {
            setRunContext({ project: data.project, work: data.work ?? null })
          } else if (data.type === 'notice') {
            notify(data.message, undefined, 'error')
          } else if (data.type === 'warning') {
            // Partial coverage: keep it on screen with the report, not only in a toast
            setRunWarnings((prev) => (prev.includes(data.message) ? prev : [...prev, data.message]))
            notify(data.message, undefined, 'error')
          } else if (data.type === 'error') {
            notify(`Agent notice: ${data.message}`, undefined, 'error')
          }
        } catch (e) {
          console.error('Error parsing SSE event', e)
        }
      }

      es.onerror = () => {
        es.close()
        activeEventSource.current = null
        if (accumulatedReport) {
          setRunStep(5)
          setView('report')
          setReportTab('brief')
        } else {
          notify("The research stream was interrupted before a report was written. Nothing was saved; try again.", undefined, 'error')
          setRunStep(0)
          setView('home')
        }
      }
    } catch (err) {
      console.error('Failed to connect to /api/research', err)
      notify("Couldn't reach the NemoSearch server, so no research was run.", undefined, 'error')
      setView('home')
    }
  }

  const loadSavedSources = (projectId: string | null) => {
    api
      .listSources(projectId ?? 'unassigned')
      .then((list) => setSavedSourceIds(Object.fromEntries(list.map((s) => [s.url, s.id]))))
      .catch(() => setSavedSourceIds({}))
  }

  const openReport = async (report: SavedReport | string) => {
    const title = typeof report === 'string' ? report : report.title
    let saved = typeof report === 'object' ? report : libraryReports.find((r) => r.title === title)
    if (saved && saved.hasReport !== false && !saved.reportText) {
      try {
        saved = await api.getReport(saved.id)
      } catch (e) {
        notify(`Couldn't open “${title}”: ${(e as Error).message}`, undefined, 'error')
        return
      }
    }

    setSubmittedQuery(saved?.question || title)
    setActiveReportId(saved?.id ?? null)
    loadSavedSources(saved?.projectId ?? null)
    if (saved && saved.reportText) {
      setLiveReport(saved.reportText)
      setLiveSources(saved.sourcesData || [])
      setLiveReasoning(saved.reasoningTrace || '')
      setRunCoverage(saved.coverage && 'complete' in saved.coverage ? saved.coverage : null)
      setRunWarnings([])
      setIsLiveRun(true)
    } else {
      setIsLiveRun(false)
      setLiveSources(sampleSources)
      setRunCoverage(null)
      setRunWarnings([])
    }
    setReportTab('brief')
    setThread((saved?.followups ?? []).map((turn) => ({ ...turn, status: 'done' as const })))
    setSidebarOpen(false)
    // Opened from the Library: remember the page; from another report: keep where that one came from
    const from = view === 'library' ? { scope, scrollY: window.scrollY } : null
    setReportReturn((prev) => (view === 'report' ? prev : from))
    setView('report')
    window.scrollTo(0, 0)
  }

  const backToLibrary = () => {
    if (!reportReturn) return
    const { scope: target, scrollY } = reportReturn
    const reportId = activeReportId
    changeScope(target)
    setView('library')
    // Once the Library has rendered: back to the same spot, with focus on the report you were reading
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        window.scrollTo(0, scrollY)
        document.querySelector<HTMLElement>(`.library-list [data-report-id="${reportId}"] .report-open`)?.focus({ preventScroll: true })
      })
    )
  }

  const updateReport = (id: string, patch: Partial<SavedReport>) =>
    setLibraryReports((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const focusReport = (id: string) =>
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-report-id="${id}"] .report-open`)?.focus())

  // Optimistic update on the server; restores the previous values and reports the error if it fails
  const patchReport = (report: SavedReport, patch: { title?: string; archived?: boolean; saved?: boolean }) => {
    updateReport(report.id, patch)
    return api.updateReport(report.id, patch).catch((e: Error) => {
      updateReport(report.id, { title: report.title, archived: report.archived, saved: report.saved })
      notify(`Couldn't update “${report.title}”: ${e.message}`, undefined, 'error')
      throw e
    })
  }

  // Research outside a project only joins the Library when saved; in a project it always belongs there
  const canSave = (report: SavedReport) => report.mine !== false && !report.projectId && report.hasReport !== false

  const setSaved = (report: SavedReport, saved: boolean) =>
    // Removed research leaves the Library entirely, archive included, and goes back to Recent research
    patchReport(report, saved ? { saved } : { saved, archived: false })
      .then(() =>
        notify(
          saved ? `Saved “${report.title}” to your Library.` : `Removed “${report.title}” from your Library. It stays in Recent research.`,
          saved ? { label: 'Open Library', run: () => { changeScope('all'); navigate('library') } } : undefined
        )
      )
      .catch(() => undefined)

  const finishRename = (report: SavedReport, value: string | null) => {
    const title = value?.trim().replace(/\s+/g, ' ')
    if (title && title !== report.title) patchReport(report, { title: title.slice(0, 80) }).catch(() => undefined)
    setRenaming(null)
    focusReport(report.id)
  }

  const duplicateReport = async (report: SavedReport) => {
    try {
      const copy = await api.duplicateReport(report.id)
      setLibraryReports((prev) => [copy, ...prev])
      notify(`Duplicated “${report.title}”.`)
      refreshProjects()
    } catch (e) {
      notify(`Couldn't duplicate “${report.title}”: ${(e as Error).message}`, undefined, 'error')
    }
  }

  const archiveReport = (report: SavedReport, archived: boolean) => {
    patchReport(report, { archived })
      .then(() =>
        notify(archived ? `Archived “${report.title}”.` : `Restored “${report.title}”.`, {
          label: 'Undo',
          run: () => patchReport({ ...report, archived }, { archived: !archived }).catch(() => undefined),
        })
      )
      .catch(() => undefined)
  }

  const deleteReport = async (report: SavedReport) => {
    const index = libraryReports.findIndex((r) => r.id === report.id)
    try {
      await api.deleteReport(report.id)
    } catch (e) {
      notify(`Couldn't delete “${report.title}”: ${(e as Error).message}`, undefined, 'error')
      return
    }
    setLibraryReports((prev) => prev.filter((r) => r.id !== report.id))
    if (activeReportId === report.id) setActiveReportId(null)
    refreshProjects()
    notify(`Deleted “${report.title}”.`, {
      label: 'Undo',
      run: () =>
        api
          .restoreReport(report.id)
          .then(() => {
            setLibraryReports((prev) => [...prev.slice(0, index), report, ...prev.slice(index)])
            refreshProjects()
          })
          .catch((e: Error) => notify(`Couldn't restore “${report.title}”: ${e.message}`, undefined, 'error')),
    })
  }

  // ---------------- projects
  const openProjectDialog = (dialog: { mode: 'create' | 'rename'; project?: Project; forRun?: boolean }) => {
    dialogOpener.current = document.activeElement as HTMLElement | null
    setProjectDialog(dialog)
  }

  const closeDialogs = () => {
    setProjectDialog(null)
    setDeletingProject(null)
    window.requestAnimationFrame(() => dialogOpener.current?.focus())
  }

  const changeScope = (next: ResearchScope) => {
    setScope(next)
    // New research follows the project you are looking at
    setRunProject(next !== 'all' && next !== 'unassigned' && !projects.find((p) => p.id === next)?.archived ? next : '')
  }
  // The Back-button listener is registered once; this keeps it on the current project list
  const changeScopeRef = useRef(changeScope)
  changeScopeRef.current = changeScope

  const openProject = (projectId: string) => {
    changeScope(projectId)
    navigate('library')
    window.scrollTo(0, 0)
  }

  const submitProjectDialog = async (name: string, description: string) => {
    if (projectDialog?.mode === 'rename' && projectDialog.project) {
      const updated = await api.updateProject(projectDialog.project.id, { name, description })
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      notify(`Renamed project to “${updated.name}”.`)
    } else {
      const created = await api.createProject(name, description)
      setProjects((prev) => [created, ...prev])
      if (projectDialog?.forRun) setRunProject(created.id)
      else changeScope(created.id)
      notify(`Created project “${created.name}”.`)
    }
    closeDialogs()
  }

  const archiveProject = async (project: Project, archived: boolean) => {
    try {
      const updated = await api.updateProject(project.id, { archived })
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      if (archived && runProject === project.id) setRunProject('')
      notify(archived ? `Archived project “${project.name}”. Its research stays available.` : `Restored project “${project.name}”.`, {
        label: 'Undo',
        run: () => archiveProject(updated, !archived),
      })
    } catch (e) {
      notify(`Couldn't update “${project.name}”: ${(e as Error).message}`, undefined, 'error')
    }
  }

  const confirmDeleteProject = async (reports: 'unassign' | 'delete') => {
    if (!deletingProject) return
    const project = deletingProject
    const result = await api.deleteProject(project.id, reports)
    setProjects((prev) => prev.filter((p) => p.id !== project.id))
    setLibraryReports((prev) =>
      reports === 'delete'
        ? prev.filter((r) => r.projectId !== project.id)
        : prev.map((r) => (r.projectId === project.id ? { ...r, projectId: null } : r))
    )
    if (runProject === project.id) setRunProject('')
    if (scope === project.id) setScope('all')
    closeDialogs()
    notify(
      reports === 'delete'
        ? `Deleted project “${project.name}” and ${result.deletedReports} report${result.deletedReports === 1 ? '' : 's'}.`
        : `Deleted project “${project.name}”. ${result.movedReports} report${result.movedReports === 1 ? '' : 's'} moved to Unassigned.`
    )
  }

  const leaveProject = async (project: Project) => {
    try {
      await api.removeMember(project.id, me.id)
      setProjects((prev) => prev.filter((p) => p.id !== project.id))
      setLibraryReports((prev) => prev.filter((r) => r.projectId !== project.id || r.mine !== false))
      if (scope === project.id) setScope('all')
      if (runProject === project.id) setRunProject('')
      notify(`You left “${project.name}”. Research you added to it stays in your Library.`)
      loadHistory()
    } catch (e) {
      notify(`Couldn't leave “${project.name}”: ${(e as Error).message}`, undefined, 'error')
    }
  }

  const projectActions = (project: Project) => project.role === 'member' ? [
    { label: 'Leave project', icon: LogOut, onSelect: () => leaveProject(project) },
  ] : [
    { label: 'Rename', icon: Pencil, onSelect: () => openProjectDialog({ mode: 'rename', project }) },
    project.archived
      ? { label: 'Unarchive', icon: ArchiveRestore, onSelect: () => archiveProject(project, false) }
      : { label: 'Archive', icon: Archive, onSelect: () => archiveProject(project, true) },
    {
      label: 'Delete',
      icon: Trash2,
      separated: true,
      onSelect: () => {
        dialogOpener.current = document.activeElement as HTMLElement | null
        setDeletingProject(project)
      },
    },
  ]

  // ---------------- saved sources and exports follow the open report's project
  const activeReport = libraryReports.find((r) => r.id === activeReportId)
  const activeProjectId = activeReport?.projectId ?? null
  const projectName = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id)?.name ?? 'project' : 'Unassigned')

  const toggleSavedSource = async (source: Source) => {
    const existing = savedSourceIds[source.url]
    try {
      if (existing) {
        await api.deleteSource(existing)
        setSavedSourceIds((prev) => {
          const next = { ...prev }
          delete next[source.url]
          return next
        })
        notify(`Removed “${source.title}” from ${projectName(activeProjectId)}.`)
      } else {
        const saved = await api.saveSource(activeProjectId, activeReport ? activeReport.id : null, source)
        setSavedSourceIds((prev) => ({ ...prev, [source.url]: saved.id }))
        notify(`Saved “${source.title}” to ${projectName(activeProjectId)}.`)
      }
      refreshProjects()
    } catch (e) {
      notify(`Couldn't update saved sources: ${(e as Error).message}`, undefined, 'error')
    }
  }

  const saveSourceButton = (source: Source) => {
    const saved = Boolean(savedSourceIds[source.url])
    return (
      <button
        type="button"
        className={`save-source ${saved ? 'saved' : ''}`}
        aria-pressed={saved}
        onClick={() => toggleSavedSource(source)}
      >
        {saved ? <BookmarkCheck size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />}
        {saved ? `Saved to ${projectName(activeProjectId)}` : 'Save source'}
      </button>
    )
  }

  const recordExport = (kind: string, filename: string, content?: string) =>
    api.recordExport(activeProjectId, activeReport ? activeReport.id : null, kind, filename, content).then(refreshProjects, () =>
      notify(`The ${kind === 'pdf' ? 'PDF' : 'outline'} export wasn't recorded in your history.`, undefined, 'error')
    )

  // Research a collaborator ran in a shared project can be copied, but only they or the project owner change it
  const canManage = (report: SavedReport) =>
    report.mine !== false || projects.find((p) => p.id === report.projectId)?.role === 'owner'

  const reportActions = (report: SavedReport, place: 'sidebar' | 'library') => canManage(report) ? [
    ...(canSave(report)
      ? [report.saved === false
          ? { label: 'Add to my Library', icon: Bookmark, onSelect: () => setSaved(report, true) }
          : { label: 'Remove from Library', icon: BookmarkX, onSelect: () => setSaved(report, false) }]
      : []),
    { label: 'Rename', icon: Pencil, onSelect: () => setRenaming({ id: report.id, place }) },
    { label: 'Duplicate', icon: CopyPlus, onSelect: () => duplicateReport(report) },
    ...(report.mine !== false && report.hasReport !== false
      ? [{ label: 'Publish to Network', icon: Upload, onSelect: () => setPublishing({ reportId: report.id }) }]
      : []),
    // Archiving belongs to the Library; unsaved research isn't in it yet
    ...(report.saved === false
      ? []
      : [report.archived
          ? { label: 'Unarchive', icon: ArchiveRestore, onSelect: () => archiveReport(report, false) }
          : { label: 'Archive', icon: Archive, onSelect: () => archiveReport(report, true) }]),
    { label: 'Delete', icon: Trash2, onSelect: () => deleteReport(report), separated: true },
  ] : [{ label: 'Duplicate to my research', icon: CopyPlus, onSelect: () => duplicateReport(report) }]

  const renameInput = (report: SavedReport, className: string) => (
    <input
      className={className}
      defaultValue={report.title}
      aria-label={`Rename “${report.title}”`}
      maxLength={80}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finishRename(report, event.currentTarget.value)
        if (event.key === 'Escape') {
          event.stopPropagation()
          finishRename(report, null)
        }
      }}
      onBlur={(event) => finishRename(report, event.currentTarget.value)}
    />
  )

  const openRouting = () => {
    routingOpener.current = document.activeElement as HTMLElement | null
    setRoutingOpen(true)
  }

  const closeRouting = () => {
    setRoutingOpen(false)
    window.requestAnimationFrame(() => routingOpener.current?.focus())
  }

  const saveRouting = (routing: Routing, scope: RoutingScope) => {
    if (scope === 'default') {
      const stored = storeRouting(routing)
      setSavedRouting(routing)
      setNextRunRouting(null)
      notify(
        stored
          ? `${presetInfo[routing.preset].label} routing saved as your default.`
          : `${presetInfo[routing.preset].label} routing applied, but your browser blocked saving it. It will reset when you reload.`,
        undefined,
        stored ? 'info' : 'error'
      )
    } else {
      setNextRunRouting(routing)
      notify(`${presetInfo[routing.preset].label} routing will be used for your next run.`)
    }
    closeRouting()
  }

  // Model overrides sent to the backend; empty for the recommended Balanced routing
  const routingParams = (models: TeamModels, preset: Routing['preset']): Record<string, string> =>
    preset === 'balanced'
      ? {}
      : {
          planner_model: models.planner,
          reader_model: models.reader,
          critic_model: models.critic,
          writer_model: models.writer,
          search_provider: models.scout,
        }

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      try {
        localStorage.setItem('nemosearch_sidebar_collapsed', collapsed ? '0' : '1')
      } catch {
        // Preference is optional
      }
      return !collapsed
    })
  }

  const shareReport = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify('Preview link copied to clipboard.')
    } catch {
      notify('Copy the preview URL from your browser to share it.')
    }
  }

  const openSlides = async () => {
    setSlidesOpen(true)
    const reportTextToUse = isLiveRun && liveReport ? liveReport : ''
    if (!reportTextToUse) {
      setSlidesData(defaultSlides)
      return
    }

    setSlidesLoading(true)
    try {
      const res = await fetch('/api/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: submittedQuery, report: reportTextToUse, models: runModels ?? teamModels }),
      })
      const data = res.ok ? await res.json() : {}
      if (Array.isArray(data.slides) && data.slides.length > 0) {
        setSlidesData(
          (data.slides as BackendSlide[]).map((s, idx) => ({
            num: String(idx + 1).padStart(2, '0'),
            title: s.title || `Key Point ${idx + 1}`,
            bullets: s.bullets || [],
          }))
        )
      } else {
        setSlidesData(defaultSlides)
        notify('Could not generate slides for this report. Showing the default outline.')
      }
    } catch {
      setSlidesData(defaultSlides)
    } finally {
      setSlidesLoading(false)
    }
  }

  const downloadSlides = () => {
    let outline = `# Executive Research Briefing: ${submittedQuery}\n\n`
    slidesData.forEach((s) => {
      outline += `## ${s.num}. ${s.title}\n`
      s.bullets.forEach((b) => {
        outline += `- ${b}\n`
      })
      outline += '\n'
    })
    const url = URL.createObjectURL(new Blob([outline], { type: 'text/markdown' }))
    const anchor = document.createElement('a')
    anchor.href = url
    const filename = `${(activeReport?.title || 'nemosearch').replace(/[^\w -]+/g, '').trim() || 'nemosearch'} - executive outline.md`
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    notify('Executive outline downloaded.')
    recordExport('slides-outline', filename, outline)
  }

  const submitFollowUp = async (event: FormEvent) => {
    event.preventDefault()
    const cleanFollowUp = followUp.trim()
    if (!cleanFollowUp || followUpSending) return

    // Earlier answered turns travel with the question so the analyst remembers the conversation
    const history = thread.filter((t) => t.status === 'done').map(({ question, answer }) => ({ question, answer }))
    const updateTurn = (patch: Partial<FollowUpTurn>) =>
      setThread((prev) => prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, ...patch } : turn)))
    setThread((prev) => [...prev, { question: cleanFollowUp, answer: '', status: 'streaming', note: 'Reasoning over the brief and this thread…' }])
    setFollowUp('')
    setFollowUpSending(true)

    const sourcesObj: Record<number, BackendSource> = {}
    currentSources.forEach((s) => {
      sourcesObj[s.id] = { id: s.id, title: s.title, url: s.url, domain: s.domain, quote: s.quote, summary: s.summary }
    })
    // The sample brief is static markup, so send its evidence as the prior report text
    const priorReport =
      isLiveRun && liveReport
        ? liveReport
        : `# ${submittedQuery}\n\n` + currentSources.map((s) => `- ${s.title}: ${s.quote} [${s.id}]`).join('\n')

    let accumulated = ''
    try {
      const response = await fetch('/api/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: cleanFollowUp,
          prior_question: submittedQuery,
          prior_report: priorReport,
          sources: sourcesObj,
          focus: focusMode,
          models: runModels ?? teamModels,
          search_provider: (runModels ?? teamModels).scout,
          history,
          report_id: isLiveRun ? activeReportId : null,
        }),
      })

      if (!response.ok || !response.body) {
        updateTurn({ status: 'error', note: `The server couldn't answer (status ${response.status}). Try again.` })
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        // Network chunks can split an SSE line, so keep the unfinished tail for the next read
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.type === 'followup_delta' && data.kind === 'text') {
                accumulated += data.delta
                updateTurn({ answer: accumulated })
              } else if (data.type === 'followup_status' && !accumulated) {
                updateTurn({ note: data.status })
              } else if (data.type === 'source' && isLiveRun) {
                const newSource = toSource({ ...(data.source as BackendSource), relevance: undefined })
                setLiveSources((prev) => (prev.some((s) => s.id === newSource.id) ? prev : [...prev, newSource]))
              } else if (data.type === 'followup_saved' && activeReportId) {
                // Keep the cached copy in step with the server so reopening the report shows the thread
                setLibraryReports((prev) =>
                  prev.map((r) =>
                    r.id === activeReportId && r.reportText
                      ? { ...r, followups: [...(r.followups ?? []), { question: cleanFollowUp, answer: accumulated }] }
                      : r
                  )
                )
              } else if (data.type === 'error') {
                notify(`Follow-up: ${data.message}`, undefined, 'error')
              }
            } catch {
              // Ignore non-json
            }
          }
        }
      }
      updateTurn(accumulated ? { status: 'done', note: '' } : { status: 'error', note: 'No answer was returned. Try asking again.' })
    } catch {
      updateTurn(
        accumulated
          ? { status: 'done', note: 'The connection dropped, so this answer may be incomplete.' }
          : { status: 'error', note: "Couldn't reach the NemoSearch server, so no answer was generated." }
      )
    } finally {
      setFollowUpSending(false)
    }
  }

  // Called while rendering the report, after currentSources is defined
  const renderFollowUp = () => (
    <form className="follow-up-box" onSubmit={submitFollowUp}>
      <label htmlFor="follow-up">Continue this research thread</label>
      {thread.length > 0 && (
        <ol className="follow-up-thread" aria-label="Follow-up questions and answers">
          {thread.map((turn, index) => (
            <li className="follow-up-turn" key={index}>
              <p className="follow-up-question">
                <span className="section-label">You asked</span>
                {turn.question}
              </p>
              <div className="follow-up-response">
                <span className="section-label">
                  {turn.status === 'streaming' ? (
                    <LoaderCircle size={12} className="spin" aria-hidden="true" />
                  ) : turn.status === 'error' ? (
                    <AlertTriangle size={12} aria-hidden="true" />
                  ) : (
                    <Check size={12} aria-hidden="true" />
                  )}{' '}
                  Nemotron Analyst
                </span>
                {turn.answer && <RenderReportBody markdown={turn.answer} sources={currentSources} onOpenSource={setSelectedSource} />}
                {turn.note && <p className={`follow-up-note ${turn.status === 'error' ? 'error' : ''}`}>{turn.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="visually-hidden" role="status">
        {followUpSending ? 'Answering your follow-up…' : thread.length && thread[thread.length - 1].status === 'done' ? 'Answer ready.' : ''}
      </p>
      <div className="follow-up-input">
        <input
          id="follow-up"
          value={followUp}
          onChange={(event) => setFollowUp(event.target.value)}
          placeholder={thread.length ? 'Ask another follow-up…' : 'Ask a follow-up question…'}
        />
        <button type="submit" aria-label="Send follow-up" disabled={followUpSending || !followUp.trim()}>
          <ArrowUpRight size={18} />
        </button>
      </div>
    </form>
  )

  const isSampleReport = !isLiveRun && submittedQuery === SAMPLE_QUERY

  const toastView = (
    <div className={`toast ${toastTone}`}>
      {toastTone === 'error' ? <AlertTriangle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
      <span>{toast}</span>
      {toastAction && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toastAction.run()
            setToast('')
            setToastAction(null)
          }}
        >
          {toastAction.label}
        </button>
      )}
    </div>
  )

  const libraryRow = (report: SavedReport, index: number) => {
    const isRenaming = renaming?.id === report.id && renaming.place === 'library'
    return (
      <div className={`library-row ${report.archived ? 'archived' : ''}`} key={report.id} data-report-id={report.id}>
        <span className="library-title">
          <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          {isRenaming ? (
            renameInput(report, 'library-rename')
          ) : (
            <button type="button" className="report-open" onClick={() => openReport(report)}>
              <strong>{report.title}</strong>
              {report.mine === false ? (
                <small>Run by {report.ownerName || 'a collaborator'}</small>
              ) : (
                report.question && report.question !== report.title && <small>{report.question}</small>
              )}
            </button>
          )}
        </span>
        <span>
          <span className="visually-hidden">Focus: </span>
          {report.mode}
        </span>
        <span>
          <span className="visually-hidden">Sources: </span>
          {report.sources}
        </span>
        <span>
          <span className="visually-hidden">Updated: </span>
          {reportTime(report, now)}
        </span>
        <ItemMenu label={`Actions for “${report.title}”`} actions={reportActions(report, 'library')} />
      </div>
    )
  }
  // Only the illustrative sample brief shows sample sources; a real run shows exactly what it retrieved
  const currentSources = isLiveRun ? liveSources : sampleSources
  const coverageIncomplete = Boolean((runCoverage && !runCoverage.complete) || runWarnings.length)
  const coverageForNotice: RunCoverage | null = runCoverage
    ? runCoverage
    : runWarnings.length
      ? { academic: true, reason: '', web: [], scholarly: [], scholarly_status: 'partial', warnings: runWarnings, unverified_citations: [], complete: false }
      : null
  const inScope = (r: SavedReport) => scope === 'all' || (scope === 'unassigned' ? !r.projectId : r.projectId === scope)
  const scopedReports = libraryReports.filter(inScope)
  const visibleReports = scopedReports.filter((r) => !r.archived).sort(byRecency)
  const archivedReports = scopedReports.filter((r) => r.archived).sort(byRecency)
  const scopeProject = projects.find((p) => p.id === scope)
  const activeProjects = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) => p.archived)
  const recentReports = visibleReports.slice(0, 6)
  const runNumber = runNumbers(visibleReports)
  const matchesFilter = (report: SavedReport) =>
    `${report.title} ${report.question ?? ''}`.toLowerCase().includes(libraryFilter.toLowerCase())
  // The Library lists saved research; unsaved runs stay in Recent research until saved
  const inLibrary = (r: SavedReport) => r.saved !== false
  const filteredReports = visibleReports.filter(inLibrary).filter(matchesFilter)
  const libraryArchived = archivedReports.filter(inLibrary)
  const filteredArchived = libraryArchived.filter(matchesFilter)
  // Paper Studio Overleaf file tree state in left sidebar
  const [studioActiveFile, setStudioActiveFile] = useState<string>('main.tex')

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {/* The dot pattern belongs to the research composer only; working views stay plain white */}
      {view === 'home' && <DotField />}

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <Logo />
          <IconButton
            label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-toggle"
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>
          <IconButton label="Close navigation" className="mobile-close" onClick={() => setSidebarOpen(false)}>
            <X size={19} />
          </IconButton>
        </div>
        <button type="button" className="new-research-button" onClick={newResearch} title="New research">
          <Plus size={17} /> <span className="nav-label">New research</span> <span className="shortcut">⌘ K</span>
        </button>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            type="button"
            className={view === 'home' || view === 'running' || view === 'report' ? 'active' : ''}
            onClick={newResearch}
            title="Research"
          >
            <Search size={17} /> <span className="nav-label">Research</span>
          </button>
          <button
            type="button"
            className={view === 'library' ? 'active' : ''}
            onClick={() => {
              // Library always opens on the whole Library; projects are one click away from there
              changeScope('all')
              navigate('library')
            }}
            title="Library"
          >
            <Library size={17} /> <span className="nav-label">Library</span>
          </button>
          <button
            type="button"
            className={view === 'network' ? 'active' : ''}
            onClick={() => navigate('network')}
            title="Network"
          >
            <NetworkIcon size={17} /> <span className="nav-label">Network</span>
            {me.pendingRequests + me.unreadNotifications > 0 && (
              <span className="nav-badge" aria-label={`${me.pendingRequests + me.unreadNotifications} new`}>
                {me.pendingRequests + me.unreadNotifications}
              </span>
            )}
          </button>
          <button
            type="button"
            className={view === 'studio' ? 'active' : ''}
            onClick={() => navigate('studio')}
            title="Paper Studio (In-App LaTeX Engine)"
          >
            <GraduationCap size={17} /> <span className="nav-label">Paper Studio</span>
          </button>
        </nav>
        {view === 'studio' ? (
          <StudioFileTree
            activeFile={studioActiveFile}
            onSelect={setStudioActiveFile}
            collapsed={sidebarCollapsed}
            onExpand={toggleSidebar}
          />
        ) : (
          <nav className="recent-block" aria-labelledby="recent-title">
            <div className="recent-header">
              <div className="section-label" id="recent-title">Recent research</div>
              <button type="button" className="recent-new-project" title="New project" aria-label="New project" onClick={() => openProjectDialog({ mode: 'create' })}>
                <FolderPlus size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="recent-scroll">
              {historyStatus === 'loading' ? (
                <p className="recent-empty">Loading your research…</p>
              ) : historyStatus === 'error' ? (
                <div className="recent-empty" role="alert">
                  <p>Your research history isn't available right now. {historyError}</p>
                  <button type="button" className="recent-more" onClick={loadHistory}>
                    Try again
                  </button>
                </div>
              ) : recentReports.length === 0 ? (
                <p className="recent-empty">
                  {scope === 'all'
                    ? 'Your research runs will appear here.'
                    : scope === 'unassigned'
                      ? 'No unassigned research.'
                      : 'No research in this project yet. Research you start while it is selected is saved here.'}
                </p>
              ) : (
                <ul className="recent-list">
                  {recentReports.map((report) => {
                    const active = report.id === activeReportId && view === 'report'
                    const isRenaming = renaming?.id === report.id && renaming.place === 'sidebar'
                    return (
                      <li className={`recent-item ${active ? 'active' : ''}`} key={report.id} data-report-id={report.id}>
                        {isRenaming ? (
                          renameInput(report, 'recent-rename')
                        ) : (
                          <button
                            type="button"
                            className="report-open recent-open"
                            aria-current={active ? 'page' : undefined}
                            title={report.question && report.question !== report.title ? report.question : undefined}
                            onClick={() => openReport(report)}
                          >
                            <span className="recent-title">{report.title}</span>
                            <span className="recent-meta">
                              {reportTime(report, now)} · {report.sources} sources
                              {runNumber.has(report.id) && ` · Run ${runNumber.get(report.id)}`}
                            </span>
                          </button>
                        )}
                        {!isRenaming && <ItemMenu label={`Actions for “${report.title}”`} actions={reportActions(report, 'sidebar')} />}
                      </li>
                    )
                  })}
                </ul>
              )}
              {visibleReports.length > recentReports.length && (
                <button type="button" className="recent-more" onClick={() => navigate('library')}>
                  View all {visibleReports.length} in Library
                </button>
              )}
            </div>
          </nav>
        )}
        <div className="sidebar-profile">
          <span className="workspace-avatar" aria-hidden="true">
            {me.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'NS'}
          </span>
          <span className="nav-label">
            <strong>{me.name}</strong>
            <small title={healthStatus.ok ? 'Nebius AI Cloud · Live' : 'Interactive preview'}>ORCID {me.orcid}</small>
          </span>
          <span className="nav-label sidebar-account-menu">
            <ItemMenu
              label="Account"
              actions={[
                { label: 'Your profile', icon: UserRound, onSelect: () => navigateNetwork({ page: 'profile' }) },
                { label: 'Download your data', icon: Download, onSelect: () => window.location.assign('/api/me/export') },
                {
                  label: 'Sign out',
                  icon: LogOut,
                  separated: true,
                  onSelect: () => {
                    api.logout().finally(() => window.location.assign('/'))
                  },
                },
              ]}
            />
          </span>
        </div>
      </aside>

      <div className="workspace">
        {/* Phones only: the sidebar is off-canvas there, so this bar holds the button that opens it */}
        <header className="topbar">
          <IconButton label="Open navigation" className="mobile-menu" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </IconButton>
          <span className="mobile-logo">
            <Logo compact />
          </span>
        </header>

        <main className={`main-content view-${view}`}>
          {view === 'home' && (
            <div className="home-grid">
              <section className="home-primary">
                <div className="home-heading">
                  <h1 id="home-title">What do you want to research?</h1>
                  <p id="home-description">
                    NemoSearch searches {providerOptions.includes('tavily') ? 'the web' : 'Wikipedia'}, plus OpenAlex and arXiv for academic
                    questions, then writes a brief where each claim cites a quoted source you can open.
                  </p>
                </div>

                <form
                  className="research-composer"
                  onSubmit={(event) => {
                    event.preventDefault()
                    startResearch()
                  }}
                >
                  <textarea
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') startResearch()
                    }}
                    placeholder={exampleTopic ? `Ask a question or name a topic, e.g. ${exampleTopic}` : 'Ask a question or name a topic'}
                    aria-labelledby="home-title"
                    aria-describedby="home-description"
                    rows={3}
                  />
                  {attachment && (
                    <div className="attachment-chip">
                      <FileText size={14} />
                      <span>{attachment}</span>
                      <span className="attachment-dest">{runProject ? `→ ${projectName(runProject)}` : 'not kept without a project'}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachment('')
                          setAttachmentFile(null)
                        }}
                        aria-label="Remove attachment"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                  <div className="composer-footer">
                    <div className="composer-tools">
                      <input
                        ref={fileRef}
                        type="file"
                        className="visually-hidden"
                        // Opened by the attach button next to it, so it stays out of the tab order
                        tabIndex={-1}
                        aria-label="Attach a file to the project"
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null
                          setAttachmentFile(file)
                          setAttachment(file?.name || '')
                        }}
                      />
                      <IconButton label="Attach a file to the project (not read during research)" onClick={() => fileRef.current?.click()}>
                        <Plus size={18} />
                      </IconButton>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={deepMode}
                        aria-describedby="deep-research-detail"
                        title="5 web searches with 4 results each, then a second round to fill gaps. Off: 3 searches with 3 results."
                        className={`deep-toggle ${deepMode ? 'enabled' : ''}`}
                        onClick={() => setDeepMode(!deepMode)}
                      >
                        <span className="toggle-track">
                          <span />
                        </span>
                        Deep research
                        <span className="visually-hidden" id="deep-research-detail">
                          On: 5 web searches with 4 results each, then a second round to fill gaps. Off: 3 searches with 3 results each.
                        </span>
                      </button>
                      <label className={`project-chip ${runProject ? 'assigned' : ''}`}>
                        <FolderOpen size={15} aria-hidden="true" />
                        <span className="visually-hidden">Save this research to</span>
                        <select
                          value={runProject}
                          onChange={(event) =>
                            event.target.value === '__new'
                              ? openProjectDialog({ mode: 'create', forRun: true })
                              : setRunProject(event.target.value)
                          }
                        >
                          <option value="">Unassigned</option>
                          {projects
                            .filter((p) => !p.archived)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          <option value="__new">New project…</option>
                        </select>
                      </label>
                      {runProject && (
                        <button
                          type="button"
                          aria-pressed={useProjectContext}
                          aria-label="Use project context"
                          title={
                            useProjectContext
                              ? "The agents read this project's paper, description and notes to understand your question."
                              : 'The question is researched on its own, without the project.'
                          }
                          className={`deep-toggle ${useProjectContext ? 'enabled' : ''}`}
                          onClick={() => setUseProjectContext(!useProjectContext)}
                        >
                          <span className="toggle-track">
                            <span />
                          </span>
                          Context
                        </button>
                      )}
                      <button
                        type="button"
                        className={`routing-chip ${activeRouting.preset === 'balanced' && !nextRunRouting ? '' : 'changed'}`}
                        aria-haspopup="dialog"
                        aria-label={`Research routing: ${routingLabel}. Customize`}
                        onClick={openRouting}
                      >
                        <SlidersHorizontal size={15} aria-hidden="true" />
                        <span>{routingLabel}</span>
                      </button>
                    </div>
                    <button type="submit" className="research-button">
                      Research <ArrowUpRight size={17} />
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {view === 'running' && (
            <section className="running-view">
              <div className="running-header">
                <button type="button" className="text-back" onClick={stopResearch}>
                  <ArrowLeft size={16} /> Stop research
                </button>
                <div className="running-title-row">
                  <div>
                    <div className="section-label">
                      <LoaderCircle size={13} className="spin" /> Deep research in progress
                    </div>
                    <h1>{submittedQuery}</h1>
                    {runContext && (
                      <p className="run-context">
                        Using context from <strong>{runContext.project}</strong>
                        {runContext.work && (
                          <>
                            {' '}· paper “{runContext.work}”
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  <span className="running-time">
                    <Clock3 size={15} /> {elapsedTime}s
                  </span>
                </div>
                <div className="run-progress">
                  <span style={{ width: `${Math.max(8, ((runStep + 0.5) / 5) * 100)}%` }} />
                </div>
              </div>
              <div className="running-grid">
                <div className="agent-run-list">
                  <div className="run-list-heading">
                    <span className="section-label">Live reasoning</span>
                    <span>{Math.min(runStep, 5)} / 5 stages</span>
                  </div>
                  {liveSteps.map((step, index) => {
                    const Icon = stepIcons[index]
                    const complete = runStep > index
                    const active = runStep === index
                    return (
                      <div className={`agent-run-row ${complete ? 'complete' : ''} ${active ? 'active' : ''}`} key={step.name}>
                        <div className="run-state">
                          {complete ? (
                            <Check size={17} />
                          ) : active ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <span>{index + 1}</span>
                          )}
                        </div>
                        <div className="run-agent-icon">
                          <Icon size={19} />
                        </div>
                        <div className="run-agent-copy">
                          <div>
                            <strong>{step.name}</strong>
                            <span>{step.model}</span>
                          </div>
                          <p>{active || complete ? step.detail : 'Waiting for previous agent...'}</p>
                        </div>
                        <span className="run-row-status">{complete ? 'Done' : active ? 'Working' : 'Queued'}</span>
                      </div>
                    )
                  })}
                </div>
                <aside className="evidence-stream">
                  <div className="run-list-heading">
                    <span className="section-label">Evidence stream</span>
                    <span>{liveSources.length === 0 ? 'Listening' : `${liveSources.length} sources retrieved`}</span>
                  </div>
                  {liveSources.length === 0 ? (
                    <div className="evidence-waiting">
                      <ScanSearch size={25} />
                      <p>The Scout is preparing a focused search across primary sources.</p>
                    </div>
                  ) : (
                    liveSources.map((source, index) => (
                      <div className="evidence-item" key={source.id || index}>
                        <div>
                          <SourceKind source={source} />
                          <span>0{index + 1}</span>
                        </div>
                        <strong>{source.title}</strong>
                        <p>{source.quote ? `“${source.quote}”` : source.snippet || 'Retrieved · queued for evidence extraction'}</p>
                      </div>
                    ))
                  )}
                </aside>
              </div>
            </section>
          )}

          {view === 'report' && (
            <section className="report-view">
              {reportReturn && (
                <button type="button" className="library-back" onClick={backToLibrary}>
                  <ArrowLeft size={15} aria-hidden="true" />{' '}
                  {projects.find((p) => p.id === reportReturn.scope)?.name ??
                    (reportReturn.scope === 'unassigned' ? 'Unassigned research' : 'Library')}
                </button>
              )}
              <div className="report-title-block">
                {/* Only the sample report says anything extra up here: that its data is not real */}
                <div className="section-label">
                  Research brief / {focusOptions.find((option) => option.id === focusMode)?.label}
                  {isSampleReport && ' · Sample with preview data'}
                </div>
                <div className="report-title-row">
                  <h1>{submittedQuery}</h1>
                  {isLiveRun && activeReport && canSave(activeReport) && (
                    <button
                      type="button"
                      className={`secondary-button report-save ${activeReport.saved === false ? '' : 'saved'}`}
                      aria-pressed={activeReport.saved !== false}
                      onClick={() => setSaved(activeReport, activeReport.saved === false)}
                      title={activeReport.saved === false ? 'Save to your Library' : 'Saved in your Library. Click to remove it.'}
                    >
                      {activeReport.saved === false ? <Bookmark size={16} aria-hidden="true" /> : <BookmarkCheck size={16} aria-hidden="true" />}
                      {activeReport.saved === false ? 'Save' : 'Saved'}
                    </button>
                  )}
                </div>
                {/* Stats and actions share one wrapping row; the actions drop below when the row is too narrow */}
                <div className="report-title-foot">
                  <div className="report-meta">
                    {coverageIncomplete ? (
                      <span className="meta-warning">
                        <AlertTriangle size={14} aria-hidden="true" /> Completed with partial coverage
                      </span>
                    ) : (
                      <span>
                        <Check size={14} /> Research complete
                      </span>
                    )}
                    <span>{currentSources.length} sources reviewed</span>
                    {currentSources.some(isPaper) && <span>{currentSources.filter(isPaper).length} scholarly papers</span>}
                    <span>5 agent stages</span>
                    {liveStats.elapsed && <span>Completed in {liveStats.elapsed}s</span>}
                  </div>
                  <div className="report-actions">
                    <button type="button" onClick={() => navigate('studio')} title="Draft full publication-grade LaTeX paper">
                      <GraduationCap size={16} /> Paper Studio (LaTeX)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        window.print()
                        recordExport('pdf', `${activeReport?.title || submittedQuery}.pdf`)
                      }}
                    >
                      <FileText size={16} /> Export PDF
                    </button>
                    <button type="button" onClick={openSlides}>
                      <Presentation size={16} /> Slides
                    </button>
                    <button type="button" onClick={shareReport}>
                      <Share2 size={16} /> Share
                    </button>
                    {activeReport && activeReport.mine !== false && liveReport && (
                      <button type="button" onClick={() => setPublishing({ reportId: activeReport.id })} title="Publish this report to NemoSearch Network">
                        <Upload size={16} /> Publish
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {!isSampleReport && <CoverageNotice coverage={coverageForNotice} />}
              <div className="report-tabs" role="tablist" aria-label="Report sections">
                {(['brief', 'sources', 'reasoning'] as const).map((tab) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={reportTab === tab}
                    className={reportTab === tab ? 'active' : ''}
                    key={tab}
                    onClick={() => setReportTab(tab)}
                  >
                    {tab === 'brief'
                      ? 'Brief'
                      : tab === 'sources'
                      ? `Sources · ${currentSources.length} shown`
                      : 'Reasoning'}
                  </button>
                ))}
              </div>

              {reportTab === 'brief' ? (
                <div className="report-layout">
                  {isLiveRun && liveReport ? (
                    <div>
                      <RenderReportBody
                        markdown={liveReport}
                        sources={currentSources}
                        onOpenSource={setSelectedSource}
                      />
                      {renderFollowUp()}
                    </div>
                  ) : isLiveRun ? (
                    <div className="report-empty" role="status">
                      <p>No report was written for this run, so there is nothing to show here.</p>
                    </div>
                  ) : (
                    <article className="report-article">
                      <section className="answer-summary">
                        <div className="section-label">The short answer</div>
                        <p>
                          Sparse models can increase parameter capacity without increasing per-token compute proportionally.
                          But real inference efficiency depends on routing, memory movement, and hardware
                          utilization—not parameter count alone.
                        </p>
                      </section>
                      <section>
                        <h2>1. Sparsity changes where capacity lives</h2>
                        <p>
                          A dense model reuses the same parameters for every input. A mixture-of-experts model instead
                          routes each example or token through selected experts, increasing total capacity while keeping
                          only part of the network active.
                          <Citation id={1} source={currentSources.find((s) => s.id === 1)} onOpen={setSelectedSource} />
                        </p>
                        <p>
                          In Mixtral’s design, a router selects two feed-forward experts for each token at every layer.
                          The important distinction is between <strong>total parameters</strong> and{' '}
                          <strong>active parameters</strong>: the former describes capacity, while the latter more closely
                          tracks per-token computation.
                          <Citation id={2} source={currentSources.find((s) => s.id === 2)} onOpen={setSelectedSource} />
                        </p>
                      </section>
                      <section>
                        <h2>2. Lower compute does not guarantee lower latency</h2>
                        <p>
                          Routing introduces communication, load-balancing, and memory-pressure trade-offs. A sparse
                          model can look efficient in FLOPs while underperforming on real hardware if experts are poorly
                          utilized or data movement dominates.
                        </p>
                        <div className="comparison-block">
                          <div>
                            <span>Dense inference</span>
                            <strong>Predictable execution</strong>
                            <p>All parameters participate. Simpler serving path; compute scales with model size.</p>
                          </div>
                          <div>
                            <span>Sparse inference</span>
                            <strong>Conditional execution</strong>
                            <p>Selected experts participate. More capacity per FLOP; more routing complexity.</p>
                          </div>
                        </div>
                      </section>
                      <section>
                        <h2>3. Evaluate the whole serving system</h2>
                        <p>
                          Model architecture is only one layer of inference efficiency. IO-aware kernels such as
                          FlashAttention show why reads and writes between memory levels matter alongside arithmetic
                          complexity.
                          <Citation id={3} source={currentSources.find((s) => s.id === 3)} onOpen={setSelectedSource} />
                        </p>
                        <p>
                          The practical choice is workload-specific: benchmark batch size, sequence length, memory
                          footprint, routing behavior, and target accelerators together. The best model on paper is not
                          necessarily the cheapest or fastest in production.
                        </p>
                      </section>
                      <div className="report-conclusion">
                        <span className="section-label">Bottom line</span>
                        <p>
                          Choose sparse architectures when their capacity benefits survive real serving constraints.
                          Otherwise, a smaller dense model with an efficient runtime may be the simpler operational win.
                        </p>
                      </div>
                      {renderFollowUp()}
                    </article>
                  )}
                  <aside className="report-sources-rail">
                    <div className="run-list-heading">
                      <span className="section-label">Evidence</span>
                      <span>{currentSources.length} primary sources</span>
                    </div>
                    {currentSources.map((source) => (
                      <button
                        type="button"
                        className="source-rail-item"
                        key={source.id}
                        onClick={() => setSelectedSource(source)}
                      >
                        <span className="source-number">[{source.id}]</span>
                        <span>
                          <strong>{source.title}</strong>
                          <small>
                            {isPaper(source) ? `Paper · ${sourceOrigin(source)}` : source.domain} · {source.relevance}% match
                          </small>
                        </span>
                      </button>
                    ))}
                    <button type="button" className="view-all-sources" onClick={() => setReportTab('sources')}>
                      View evidence details <ArrowRight size={15} />
                    </button>
                    {isLiveRun && relatedWorks.length > 0 && (
                      <div className="related-works">
                        <div className="run-list-heading">
                          <span className="section-label">On Network</span>
                          <span>Researchers working on this</span>
                        </div>
                        {relatedWorks.slice(0, 3).map((w) => (
                          <button type="button" className="source-rail-item" key={w.id} onClick={() => navigateNetwork({ page: 'work', id: w.id })}>
                            <span className="source-number">
                              <NetworkIcon size={12} aria-hidden="true" />
                            </span>
                            <span>
                              <strong>{w.title}</strong>
                              <small>
                                {w.owner?.name}
                                {w.owner?.affiliation && ` · ${w.owner.affiliation}`}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </aside>
                </div>
              ) : reportTab === 'sources' ? (
                <div className="sources-page">
                  <div className="sources-page-intro">
                    <h2>Evidence you can inspect.</h2>
                    <p>Every extracted claim stays connected to its original source and verbatim context.</p>
                    {!isSampleReport && <CoverageLog coverage={runCoverage} />}
                  </div>
                  {isLiveRun && currentSources.length === 0 && <p className="workspace-empty">This run retrieved no sources.</p>}
                  {currentSources.map((source) => (
                    <div className="source-detail-row" key={source.id}>
                      <span className="source-detail-id">0{source.id}</span>
                      <div>
                        <div className="source-detail-meta">
                          <SourceKind source={source} />
                          <span>{source.relevance}% relevance</span>
                        </div>
                        <h3>{source.title}</h3>
                        {isPaper(source) ? <SourceProvenance source={source} /> : <p>{source.authors || source.domain}</p>}
                        {source.quote || source.snippet || (source.summary && source.access !== 'metadata') ? (
                          <blockquote>“{source.quote || source.snippet || source.summary}”</blockquote>
                        ) : null}
                        {!isPaper(source) && <SourceProvenance source={source} />}
                        <div className="source-detail-actions">
                          <button type="button" onClick={() => setSelectedSource(source)}>
                            <ScanSearch size={15} /> Inspect extraction
                          </button>
                          {saveSourceButton(source)}
                          <a href={source.url} target="_blank" rel="noreferrer">
                            Open original <ExternalLink size={14} />
                          </a>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="reasoning-page">
                  <div className="reasoning-intro">
                    <div>
                      <div className="section-label">Model routing</div>
                      <h2>
                        Five specialists.
                        <br />
                        One evidence thread.
                      </h2>
                    </div>
                    <p>
                      NemoSearch assigns each stage to the smallest model that can do the job well, reserving Ultra for
                      the final synthesis.
                    </p>
                  </div>
                  <div className="reasoning-table">
                    {defaultResearchSteps.map((step, index) => {
                      const Icon = stepIcons[index]
                      return (
                        <div className="reasoning-row" key={step.name}>
                          <span className="reasoning-check">
                            <Check size={15} />
                          </span>
                          <Icon size={18} />
                          <strong>{step.name}</strong>
                          <span>{step.model}</span>
                          <p>{step.detail}</p>
                        </div>
                      )
                    })}
                  </div>
                  {liveReasoning && (
                    <div style={{ marginTop: '35px', padding: '24px', border: '1px dotted var(--hairline)', borderRadius: '14px', background: 'var(--paper)' }}>
                      <span className="section-label" style={{ marginBottom: '12px' }}>
                        <BrainCircuit size={14} /> Ultra Reasoning Trace
                      </span>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: "'IBM Plex Mono', monospace", fontSize: '12px', color: 'var(--muted-text)', lineHeight: 1.6 }}>
                        {liveReasoning}
                      </pre>
                    </div>
                  )}
                  <div className="telemetry-grid">
                    <div>
                      <span>Model tiers used</span>
                      <strong>3</strong>
                      <small>Nano · Super · Ultra</small>
                    </div>
                    <div>
                      <span>Parallel readers</span>
                      <strong>{Math.max(4, currentSources.length)}</strong>
                      <small>Evidence threads</small>
                    </div>
                    <div>
                      <span>Coverage gaps closed</span>
                      <strong>2</strong>
                      <small>Critic follow-ups</small>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {view === 'library' && (
            <section className="library-view">
              {scope !== 'all' && (
                <button type="button" className="library-back" onClick={() => openProject('all')}>
                  <ArrowLeft size={15} aria-hidden="true" /> Library
                </button>
              )}
              <div className="page-heading">
                <div>
                  {scopeProject ? (
                    <>
                      <h1 className="project-title">{scopeProject.name}</h1>
                      {/* Only status worth stating gets a line under the title; a plain project has none */}
                      {(scopeProject.archived || scopeProject.role === 'member') && (
                        <p className="project-status">
                          {scopeProject.archived ? 'Archived project' : `Shared by ${scopeProject.owner?.name ?? 'a collaborator'}`}
                        </p>
                      )}
                      {/* A collaboration's header already says what it is about */}
                      {scopeProject.description && !(scopeProject.work && scopeProject.description.startsWith('Shared through NemoSearch Network')) && (
                        <p className="project-description">{scopeProject.description}</p>
                      )}
                    </>
                  ) : scope === 'unassigned' ? (
                    <h1>Unassigned research</h1>
                  ) : (
                    <h1>Library</h1>
                  )}
                </div>
                {scopeProject && (
                  <div className="page-heading-actions">
                    <ItemMenu label={`Actions for project “${scopeProject.name}”`} actions={projectActions(scopeProject)} />
                  </div>
                )}
              </div>
              {scopeProject?.work && (
                <CollaborationHeader
                  project={{ ...scopeProject, work: scopeProject.work }}
                  onOpenWork={(id) => navigateNetwork({ page: 'work', id })}
                  onResearch={() => {
                    setRunProject(scopeProject.id)
                    setUseProjectContext(true)
                    setQuery(`What has been published on the topic of this paper since it came out, and what is still open?`)
                    navigate('home')
                  }}
                />
              )}
              {scope === 'all' && (
                <p className="library-storage">
                  Private to you and anyone you share a project with. Nothing here is published unless you publish it to Network.
                </p>
              )}
              {scope === 'all' && (
                <section className="project-cards" aria-labelledby="project-cards-title">
                  <div className="project-cards-head">
                    <h2 id="project-cards-title" className="section-label">
                      Projects
                    </h2>
                    {/* What the old dropdown also reached: research outside any project, and archived projects */}
                    <button type="button" className="text-link" onClick={() => openProject('unassigned')}>
                      Unassigned research
                    </button>
                    {archivedProjects.length > 0 && (
                      <button
                        type="button"
                        className="text-link"
                        aria-expanded={showArchivedProjects}
                        onClick={() => setShowArchivedProjects(!showArchivedProjects)}
                      >
                        {showArchivedProjects ? 'Hide archived' : `Archived · ${archivedProjects.length}`}
                      </button>
                    )}
                  </div>
                  <ul>
                    {[...activeProjects, ...(showArchivedProjects ? archivedProjects : [])].map((p) => {
                      const shared = p.role === 'member' || p.counts.members > 0
                      return (
                        <li key={p.id}>
                          <button type="button" className={`project-card ${p.archived ? 'archived' : ''}`} onClick={() => openProject(p.id)}>
                            <span className="project-card-kind">
                              {p.archived ? <Archive size={14} aria-hidden="true" /> : shared ? <Users size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
                              {p.archived
                                ? 'Archived'
                                : p.role === 'member'
                                ? `Shared by ${p.owner?.name ?? 'a collaborator'}`
                                : p.counts.members > 0
                                  ? `Shared with ${p.counts.members} ${p.counts.members === 1 ? 'person' : 'people'}`
                                  : 'Only you'}
                            </span>
                            <strong>{p.name}</strong>
                            <small>
                              {p.counts.reports} research {p.counts.reports === 1 ? 'run' : 'runs'} · {relativeTime(p.updatedAt, now)}
                            </small>
                          </button>
                        </li>
                      )
                    })}
                    <li>
                      <button type="button" className="project-card project-card-new" onClick={() => openProjectDialog({ mode: 'create' })}>
                        <Plus size={16} aria-hidden="true" /> New project
                      </button>
                    </li>
                  </ul>
                </section>
              )}
              <div className="library-toolbar">
              <div className="library-search">
                <Search size={18} />
                <input
                  value={libraryFilter}
                  onChange={(event) => setLibraryFilter(event.target.value)}
                  placeholder="Filter your research…"
                  aria-label="Filter research library"
                />
                {libraryFilter && (
                  <button type="button" onClick={() => setLibraryFilter('')} aria-label="Clear filter">
                    <X size={16} />
                  </button>
                )}
              </div>
              </div>
              <div className="library-list">
                <div className="library-list-head" aria-hidden="true">
                  <span>Research</span>
                  <span>Focus</span>
                  <span>Sources</span>
                  <span>Updated</span>
                  <span />
                </div>
                {filteredReports.map((report, index) => libraryRow(report, index))}
                {filteredReports.length === 0 && (
                  <div className="library-empty">
                    {libraryFilter
                      ? `No research matches “${libraryFilter}”.`
                      : scopeProject
                        ? 'No research in this project yet.'
                        : 'Nothing saved yet. Use Save on a report, or “Add to my Library” in Recent research, to keep it here.'}
                  </div>
                )}
                {libraryArchived.length > 0 && (
                  <div className="library-archived">
                    <button
                      type="button"
                      className="library-archived-toggle"
                      aria-expanded={showArchived}
                      aria-controls="library-archived-list"
                      onClick={() => setShowArchived(!showArchived)}
                    >
                      <Archive size={15} aria-hidden="true" /> Archived · {libraryArchived.length}
                      <ChevronDown size={14} aria-hidden="true" className={showArchived ? 'flipped' : ''} />
                    </button>
                    {showArchived && (
                      <div id="library-archived-list">
                        {filteredArchived.map((report, index) => libraryRow(report, index))}
                      </div>
                    )}
                  </div>
                )}
                {scope !== 'all' && (
                  <ProjectWorkspace key={scope} scope={scope} refreshKey={workspaceKey} notify={notify} onChanged={refreshProjects} meId={me.id} />
                )}
              </div>
            </section>
          )}

          {view === 'network' && (
            <NetworkView
              route={networkRoute}
              onPublish={() => setPublishing({})}
              ctx={{
                me,
                navigate: navigateNetwork,
                notify,
                refreshMe: () => {
                  refreshMe()
                  refreshProjects()
                },
                projects,
                reports: libraryReports,
                openProject: (projectId) => {
                  refreshProjects()
                  loadHistory()
                  openProject(projectId)
                },
                orcidBase,
              }}
            />
          )}

          {view === 'studio' && (
            <PaperStudio
              // Only a real research run preselects a topic; the sample brief never does
              topic={isLiveRun ? submittedQuery : ''}
              reportText={isLiveRun ? liveReport : ''}
              sources={isLiveRun ? currentSources : []}
              savedReports={libraryReports}
              activeFileId={studioActiveFile}
              onSelectFile={setStudioActiveFile}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      {selectedSource && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedSource(null)
          }}
        >
          <section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-modal-title">
            <div className="modal-top">
              <span className="section-label">Evidence verification / [{selectedSource.id}]</span>
              <IconButton label="Close source" onClick={() => setSelectedSource(null)}>
                <X size={19} />
              </IconButton>
            </div>
            <div className="source-modal-domain">
              <SourceKind source={selectedSource} />
              <span>{selectedSource.relevance}% relevance</span>
            </div>
            <h2 id="source-modal-title">{selectedSource.title}</h2>
            {isPaper(selectedSource) ? (
              <SourceProvenance source={selectedSource} />
            ) : (
              <p className="source-modal-authors">{selectedSource.authors || selectedSource.domain}</p>
            )}
            {selectedSource.access === 'metadata' ? null : (
              <div className="extracted-quote">
                <span className="section-label">
                  <Check size={13} /> {!isPaper(selectedSource) ? 'Verbatim extraction' : selectedSource.access === 'fulltext' ? 'Verbatim from the full text' : 'Verbatim from the abstract'}
                </span>
                <blockquote>“{selectedSource.quote || selectedSource.snippet || selectedSource.summary}”</blockquote>
              </div>
            )}
            {!isPaper(selectedSource) && <SourceProvenance source={selectedSource} />}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(selectedSource.quote || selectedSource.summary || '')
                  notify('Evidence quote copied.')
                }}
              >
                <Copy size={16} /> Copy quote
              </button>
              {saveSourceButton(selectedSource)}
              <a href={selectedSource.url} target="_blank" rel="noreferrer">
                Open original source <ExternalLink size={15} />
              </a>
            </div>
          </section>
        </div>
      )}

      {slidesOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSlidesOpen(false)
          }}
        >
          <section className="slides-modal" role="dialog" aria-modal="true" aria-labelledby="slides-title">
            <div className="modal-top">
              <span className="section-label">Executive synthesis</span>
              <IconButton label="Close slide outline" onClick={() => setSlidesOpen(false)}>
                <X size={19} />
              </IconButton>
            </div>
            <h2 id="slides-title">Five slides. One clear decision.</h2>
            <p className="slides-subtitle">
              {slidesLoading
                ? 'Synthesizing 5 executive slides with Nemotron...'
                : 'A presentation-ready outline generated from the research brief.'}
            </p>
            <ol className="slide-outline">
              {slidesData.map((slide, sIdx) => (
                <li key={sIdx}>
                  <span>{slide.num}</span>
                  <div>
                    <strong>{slide.title}</strong>
                    {slide.bullets.map((b, bIdx) => (
                      <p key={bIdx}>{b}</p>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="primary-button download-button"
              onClick={downloadSlides}
              disabled={slidesLoading}
            >
              <Download size={16} /> Download outline
            </button>
          </section>
        </div>
      )}

      {routingOpen && (
        <RoutingEditor
          routing={activeRouting}
          presets={presets}
          modelOptions={modelOptions}
          providerOptions={providerOptions}
          catalogStatus={catalogStatus}
          onCancel={closeRouting}
          onSave={saveRouting}
        />
      )}

      {projectDialog && (
        <ProjectDialog
          mode={projectDialog.mode}
          initialName={projectDialog.project?.name}
          initialDescription={projectDialog.project?.description}
          onCancel={closeDialogs}
          onSubmit={submitProjectDialog}
        />
      )}
      {publishing && (
        <PublishDialog
          me={me}
          reports={libraryReports}
          initialReportId={publishing.reportId}
          onCancel={() => setPublishing(null)}
          onDone={(work, uploadError) => {
            setPublishing(null)
            if (uploadError) notify(`Created “${work.title}”, but the file didn't upload: ${uploadError}`, undefined, 'error')
            else notify(`Created “${work.title}”. It's private until you change its visibility.`)
            navigateNetwork({ page: 'work', id: work.id })
          }}
        />
      )}
      {deletingProject && <DeleteProjectDialog project={deletingProject} onCancel={closeDialogs} onConfirm={confirmDeleteProject} />}

      {/* Live regions stay mounted so screen readers reliably announce what appears in them */}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {toast && toastTone === 'info' && toastView}
      </div>
      <div className="toast-region" role="alert" aria-atomic="true">
        {toast && toastTone === 'error' && toastView}
      </div>
    </div>
  )
}
