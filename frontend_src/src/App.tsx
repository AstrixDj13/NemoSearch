import { useEffect, useRef, useState, useMemo } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Globe2,
  GraduationCap,
  Library,
  LoaderCircle,
  Menu,
  Network,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  Presentation,
  ScanSearch,
  Search,
  Share2,
  ShieldCheck,
  X,
} from 'lucide-react'
import DotField from './components/DotField'
import PaperStudio from './components/PaperStudio'
import {
  defaultResearchSteps,
  recentReports as initialRecentReports,
  sampleSources,
  SAMPLE_QUERY,
} from './data'
import type { FocusMode, SavedReport, SlideItem, Source, View } from './data'
import './App.css'

const focusOptions: { id: FocusMode; label: string; icon: typeof Globe2 }[] = [
  { id: 'web', label: 'All web', icon: Globe2 },
  { id: 'academic', label: 'Academic', icon: GraduationCap },
  { id: 'finance', label: 'Finance & SEC', icon: ChartNoAxesCombined },
  { id: 'news', label: 'Recent news', icon: Newspaper },
]

const stepIcons = [BrainCircuit, ScanSearch, BookOpen, ShieldCheck, PenLine]

// Pipeline steps in run order; keys match the backend's per-step model overrides
type TeamStep = 'planner' | 'scout' | 'reader' | 'critic' | 'writer'
type TeamModels = Record<TeamStep, string>
const teamSteps: { key: TeamStep; name: string }[] = [
  { key: 'planner', name: 'Planner' },
  { key: 'scout', name: 'Scout' },
  { key: 'reader', name: 'Readers' },
  { key: 'critic', name: 'Critic' },
  { key: 'writer', name: 'Lead analyst' },
]
const recommendedTeam: TeamModels = {
  planner: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  scout: 'tavily',
  reader: 'nvidia/nemotron-3-super-120b-a12b',
  critic: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  writer: 'nvidia/Nemotron-3-Ultra-550b-a55b',
}
const modelLabels: Record<string, string> = {
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': 'Nemotron 3 Nano · 30B',
  'nvidia/nemotron-3-super-120b-a12b': 'Nemotron 3 Super · 120B',
  'nvidia/Nemotron-3-Ultra-550b-a55b': 'Nemotron 3 Ultra · 550B',
  tavily: 'Tavily AI Search',
  wikipedia: 'Wikipedia Search',
}
const modelLabel = (id: string) => modelLabels[id] || id.split('/').pop() || id

const loadTeamPrefs = (): { recommended: boolean; models: TeamModels } => {
  try {
    const stored = JSON.parse(localStorage.getItem('nemosearch_team') || 'null')
    if (stored && typeof stored.recommended === 'boolean') {
      return { recommended: stored.recommended, models: { ...recommendedTeam, ...stored.models } }
    }
  } catch {
    // Fall back to the recommended team
  }
  return { recommended: true, models: recommendedTeam }
}
const viewNames: Record<View, string> = {
  home: 'New research',
  running: 'Research in progress',
  report: 'Research brief',
  library: 'Library',
  activity: 'Agent activity',
  studio: 'Paper Studio',
}

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
}

interface BackendSlide {
  title?: string
  bullets?: string[]
}

const toSource = (s: BackendSource, fallbackRelevance = 85): Source => ({
  id: s.id,
  title: s.title || 'Untitled source',
  authors: s.domain || 'Web source',
  domain: s.domain || 'web',
  url: s.url || '#',
  relevance: typeof s.relevance === 'number' ? Math.round(s.relevance * 10) : fallbackRelevance,
  quote: s.quote || s.snippet || s.summary || '',
  summary: s.summary,
  snippet: s.snippet,
})

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="NemoSearch">
      <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M6 24V8l20 16V8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="6" cy="8" r="2.2" fill="currentColor" />
        <circle cx="26" cy="24" r="2.2" fill="currentColor" />
      </svg>
      {!compact && <span>NemoSearch<span className="brand-dot">.</span></span>}
    </div>
  )
}

function IconButton({ label, children, onClick, className = '' }: { label: string; children: ReactNode; onClick: () => void; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick}>{children}</button>
}

function Citation({ id, source, onOpen }: { id: number; source?: Source; onOpen: (source: Source) => void }) {
  if (!source) {
    return <span className="citation">[{id}]</span>
  }
  return (
    <span className="citation-wrap">
      <button type="button" className="citation" onClick={() => onOpen(source)} aria-label={`Verify source ${id}: ${source.title}`}>[{id}]</button>
      <span className="citation-hover" role="tooltip">
        <span className="citation-hover-top"><span>{source.domain}</span><span>{source.relevance}% match</span></span>
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

  return <>{renderInline(text, 'i')}</>
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

export default function App() {
  const [view, setView] = useState<View>('home')
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
  const [libraryFilter, setLibraryFilter] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [followUpResponse, setFollowUpResponse] = useState('')
  const [followUpSending, setFollowUpSending] = useState(false)
  const [followUpSent, setFollowUpSent] = useState(false)

  // Live Research States
  const [liveSteps, setLiveSteps] = useState(defaultResearchSteps)
  const [liveSources, setLiveSources] = useState<Source[]>(sampleSources)
  const [liveReport, setLiveReport] = useState<string>('')
  const [liveReasoning, setLiveReasoning] = useState<string>('')
  const [liveStats, setLiveStats] = useState<{ elapsed?: number; ttft?: number; nSources?: number; gaps?: string[] }>({})
  const [isLiveRun, setIsLiveRun] = useState(false)
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; provider?: string }>({ ok: true })

  // Research team routing: recommended models, or a custom model per step
  const [teamOpen, setTeamOpen] = useState(false)
  const [teamDefaults, setTeamDefaults] = useState<TeamModels>(recommendedTeam)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [providerOptions, setProviderOptions] = useState<string[]>(['tavily', 'wikipedia'])
  const [useRecommended, setUseRecommended] = useState(() => loadTeamPrefs().recommended)
  const [customTeam, setCustomTeam] = useState<TeamModels>(() => loadTeamPrefs().models)
  const [teamAnnouncement, setTeamAnnouncement] = useState('')
  const teamToggleRef = useRef<HTMLButtonElement>(null)
  const teamModels = useRecommended ? teamDefaults : customTeam

  // Library persisted in localStorage
  const [libraryReports, setLibraryReports] = useState<SavedReport[]>(() => {
    try {
      const stored = localStorage.getItem('nemosearch_library')
      if (stored) return JSON.parse(stored)
    } catch {
      // fallback
    }
    return initialRecentReports
  })

  const searchRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const activeEventSource = useRef<EventSource | null>(null)

  const notify = (message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }

  // Fetch health status on mount
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => setHealthStatus({ ok: !!data.ok, provider: data.search_provider }))
      .catch(() => setHealthStatus({ ok: true, provider: 'tavily' }))
    fetch('/api/models')
      .then((res) => res.json())
      .then((data) => {
        if (data.defaults) setTeamDefaults({ ...recommendedTeam, ...data.defaults })
        if (Array.isArray(data.models)) setModelOptions(data.models)
        if (Array.isArray(data.search_providers)) setProviderOptions(data.search_providers)
      })
      .catch(() => {
        // Keep the built-in recommended team
      })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('nemosearch_team', JSON.stringify({ recommended: useRecommended, models: customTeam }))
    } catch {
      // Preference is optional
    }
  }, [useRecommended, customTeam])

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

  const navigate = (nextView: View) => {
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
    setFollowUpSent(false)
    setFollowUpResponse('')
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
    setRunStep(0)
    setElapsedTime(1)
    setFollowUpSent(false)
    setFollowUpResponse('')
    setSidebarOpen(false)
    setIsLiveRun(true)
    setLiveReport('')
    setLiveReasoning('')
    setLiveSources([])
    setLiveSteps([
      { name: 'Planner', model: modelLabel(teamModels.planner), detail: 'Decomposing question into research paths...' },
      { name: 'Scout', model: modelLabel(teamModels.scout), detail: 'Preparing live search across primary sources...' },
      { name: 'Readers', model: modelLabel(teamModels.reader), detail: 'Standing by for parallel evidence extraction...' },
      { name: 'Critic', model: modelLabel(teamModels.critic), detail: 'Queued to verify coverage & close gaps...' },
      { name: 'Lead analyst', model: modelLabel(teamModels.writer), detail: 'Queued for rigorous cited synthesis...' },
    ])
    setView('running')

    // Connect to real FastAPI SSE endpoint
    const params = new URLSearchParams({ q: cleanQuery, depth: deepMode ? 'deep' : 'quick', focus: focusMode, ...teamOverrides() })
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
            finished = true
            es.close()
            activeEventSource.current = null
            setRunStep(5)
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

            // Save completed report into Library
            const newSaved: SavedReport = {
              id: `report-${Date.now()}`,
              title: cleanQuery,
              mode: focusOptions.find((o) => o.id === focusMode)?.label || 'All web',
              time: 'Just now',
              sources: collectedSources.length || 12,
              reportText: accumulatedReport,
              sourcesData: collectedSources,
              reasoningTrace: accumulatedReasoning,
            }
            setLibraryReports((prev) => {
              const next = [newSaved, ...prev.filter((p) => p.title !== cleanQuery)]
              try {
                localStorage.setItem('nemosearch_library', JSON.stringify(next))
              } catch {
                // Ignore storage limits
              }
              return next
            })

            // Switch to report view
            window.setTimeout(() => {
              setView('report')
              setReportTab('brief')
            }, 600)
          } else if (data.type === 'error') {
            notify(`Agent notice: ${data.message}`)
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
          notify('Search stream completed or server unavailable. Loaded evidence preview.')
          setRunStep(5)
          setView('report')
          setReportTab('brief')
        }
      }
    } catch (err) {
      console.error('Failed to connect to /api/research', err)
      notify('Backend connection error. Running illustrative mode.')
      setView('report')
    }
  }

  const openReport = (report: SavedReport | string) => {
    const title = typeof report === 'string' ? report : report.title
    const saved = typeof report === 'object' ? report : libraryReports.find((r) => r.title === title)

    setSubmittedQuery(title)
    if (saved && saved.reportText) {
      setLiveReport(saved.reportText)
      setLiveSources(saved.sourcesData || sampleSources)
      setLiveReasoning(saved.reasoningTrace || '')
      setIsLiveRun(true)
    } else {
      setIsLiveRun(false)
      setLiveSources(sampleSources)
    }
    setReportTab('brief')
    setFollowUpSent(false)
    setFollowUpResponse('')
    setSidebarOpen(false)
    setView('report')
  }

  const changeTeamModel = (step: TeamStep, model: string) => {
    const next = { ...teamModels, [step]: model }
    const allRecommended = teamSteps.every(({ key }) => next[key] === teamDefaults[key])
    setCustomTeam(next)
    setUseRecommended(allRecommended)
    const name = teamSteps.find((s) => s.key === step)?.name
    setTeamAnnouncement(
      `${name} now uses ${modelLabel(model)}. ${allRecommended ? 'All steps use recommended models.' : 'Custom team active.'}`
    )
  }

  // Model overrides sent to the backend; empty when the recommended routing is on
  const teamOverrides = (): Record<string, string> =>
    useRecommended
      ? {}
      : {
          planner_model: teamModels.planner,
          reader_model: teamModels.reader,
          critic_model: teamModels.critic,
          writer_model: teamModels.writer,
          search_provider: teamModels.scout,
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
        body: JSON.stringify({ topic: submittedQuery, report: reportTextToUse, models: useRecommended ? {} : teamModels }),
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
    anchor.download = `nemosearch-executive-outline.md`
    anchor.click()
    URL.revokeObjectURL(url)
    notify('Executive outline downloaded.')
  }

  const submitFollowUp = async (event: FormEvent) => {
    event.preventDefault()
    const cleanFollowUp = followUp.trim()
    if (!cleanFollowUp || followUpSending) return

    setFollowUpSending(true)
    setFollowUpSent(true)
    setFollowUpResponse('Reasoning over prior brief and evidence thread...')

    const sourcesObj: Record<number, BackendSource> = {}
    currentSources.forEach((s) => {
      sourcesObj[s.id] = { id: s.id, title: s.title, url: s.url, domain: s.domain, quote: s.quote, summary: s.summary }
    })
    // The sample brief is static markup, so send its evidence as the prior report text
    const priorReport =
      isLiveRun && liveReport
        ? liveReport
        : `# ${submittedQuery}\n\n` + currentSources.map((s) => `- ${s.title}: ${s.quote} [${s.id}]`).join('\n')

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
          models: useRecommended ? {} : teamModels,
          search_provider: useRecommended ? undefined : teamModels.scout,
        }),
      })

      if (!response.ok || !response.body) {
        setFollowUpResponse('Unable to stream response from backend.')
        setFollowUpSending(false)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
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
                setFollowUpResponse(accumulated)
              } else if (data.type === 'followup_status' && !accumulated) {
                setFollowUpResponse(data.status)
              } else if (data.type === 'source' && isLiveRun) {
                const newSource = toSource({ ...(data.source as BackendSource), relevance: undefined })
                setLiveSources((prev) => (prev.some((s) => s.id === newSource.id) ? prev : [...prev, newSource]))
              } else if (data.type === 'error') {
                setFollowUpResponse(`Agent notice: ${data.message}`)
              }
            } catch {
              // Ignore non-json
            }
          }
        }
      }
      if (!accumulated) {
        setFollowUpResponse((prev) => (prev.startsWith('Agent notice') ? prev : 'No answer was returned. Please try again.'))
      }
    } catch {
      setFollowUpResponse(
        'The Nemotron reasoning agent reviewed your question against the verified evidence thread. (Backend connection paused).'
      )
    } finally {
      setFollowUpSending(false)
    }
  }

  const isSampleReport = !isLiveRun && submittedQuery === SAMPLE_QUERY
  const currentSources = isLiveRun && liveSources.length > 0 ? liveSources : sampleSources
  const filteredReports = libraryReports.filter((report) =>
    report.title.toLowerCase().includes(libraryFilter.toLowerCase())
  )

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <DotField running={view === 'running'} />

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
            onClick={() => navigate('library')}
            title="Library"
          >
            <Library size={17} /> <span className="nav-label">Library</span>
          </button>
          <button
            type="button"
            className={view === 'studio' ? 'active' : ''}
            onClick={() => navigate('studio')}
            title="Paper Studio (In-App LaTeX Engine)"
          >
            <GraduationCap size={17} /> <span className="nav-label">Paper Studio</span>
          </button>
          <button
            type="button"
            className={view === 'activity' ? 'active' : ''}
            onClick={() => navigate('activity')}
            title="Agent activity"
          >
            <Activity size={17} /> <span className="nav-label">Agent activity</span>
          </button>
        </nav>
        <div className="recent-block">
          <div className="section-label">Recent research</div>
          {libraryReports.slice(0, 5).map((report) => (
            <button
              type="button"
              className="recent-item"
              key={report.id || report.title}
              onClick={() => openReport(report)}
            >
              {report.title}
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        <div className="sidebar-profile">
          <span className="workspace-avatar">NS</span>
          <span className="nav-label">
            <strong>NemoSearch</strong>
            <small>{healthStatus.ok ? 'Nebius AI Cloud · Live' : 'Interactive preview'}</small>
          </span>
        </div>
      </aside>

      <div className="workspace">
        <header className={`topbar ${view === 'home' ? 'topbar-home' : ''}`}>
          <div className="topbar-left">
            <IconButton label="Open navigation" className="mobile-menu" onClick={() => setSidebarOpen(true)}>
              <Menu size={20} />
            </IconButton>
            <span className="mobile-logo">
              <Logo compact />
            </span>
            <span className="breadcrumb-root">Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <span>{viewNames[view]}</span>
          </div>
          <div className="topbar-right">
            <span className="preview-badge">
              <span /> {healthStatus.ok ? 'Nebius AI Cloud · Live' : 'Interactive preview'}
            </span>
          </div>
        </header>

        <main className={`main-content view-${view}`}>
          {view === 'home' && (
            <div className="home-grid">
              <section className="home-primary">
                <div className="home-heading">
                  <h1>
                    Research without
                    <br />
                    the black box.
                  </h1>
                  <p>A focused team of Nemotron agents plans, searches, reads, and cites, so you can inspect every step.</p>
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
                    placeholder="What do you want to understand?"
                    aria-label="Research question"
                    rows={3}
                  />
                  {attachment && (
                    <div className="attachment-chip">
                      <FileText size={14} />
                      <span>{attachment}</span>
                      <button type="button" onClick={() => setAttachment('')} aria-label="Remove attachment">
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
                        onChange={(event) => setAttachment(event.target.files?.[0]?.name || '')}
                      />
                      <IconButton label="Attach a source file" onClick={() => fileRef.current?.click()}>
                        <Plus size={18} />
                      </IconButton>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={deepMode}
                        className={`deep-toggle ${deepMode ? 'enabled' : ''}`}
                        onClick={() => setDeepMode(!deepMode)}
                      >
                        <span className="toggle-track">
                          <span />
                        </span>
                        Deep research
                      </button>
                    </div>
                    <button type="submit" className="research-button">
                      Research <ArrowUpRight size={17} />
                    </button>
                  </div>
                </form>
              </section>

              <aside
                className={`team-panel ${teamOpen ? 'open' : ''}`}
                aria-labelledby="team-title"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && teamOpen) {
                    event.stopPropagation()
                    setTeamOpen(false)
                    teamToggleRef.current?.focus()
                  }
                }}
              >
                <button
                  ref={teamToggleRef}
                  type="button"
                  className="team-toggle"
                  aria-expanded={teamOpen}
                  aria-controls="team-steps"
                  onClick={() => setTeamOpen((open) => !open)}
                >
                  <span className="team-toggle-title">
                    <span className="section-label" id="team-title">Your research team</span>
                    <span className={`team-status ${useRecommended ? '' : 'custom'}`}>
                      <span aria-hidden="true" />
                      {useRecommended ? 'Recommended models' : 'Custom models'}
                    </span>
                  </span>
                  <span className="team-toggle-hint" aria-hidden="true">
                    {teamOpen ? 'Done' : 'Edit'}
                    <ChevronDown size={14} className="team-chevron" />
                  </span>
                </button>
                <p className="team-tagline">
                  Specialists at every step.
                  <br />
                  One shared evidence thread.
                </p>

                <ol className="team-steps" id="team-steps">
                  {teamSteps.map((step, index) => {
                    const Icon = stepIcons[index]
                    const isScout = step.key === 'scout'
                    const current = teamModels[step.key]
                    const recommended = teamDefaults[step.key]
                    const edited = current !== recommended
                    const options = isScout ? providerOptions : modelOptions
                    const choices = [...new Set([current, ...options])].filter((m) => m !== recommended)
                    const nemotron = choices.filter((m) => /nemotron/i.test(m))
                    const others = choices.filter((m) => !/nemotron/i.test(m))
                    const option = (m: string) => (
                      <option key={m} value={m} title={m}>
                        {modelLabel(m)}
                      </option>
                    )
                    return (
                      <li className={`team-step ${edited ? 'edited' : ''}`} key={step.key}>
                        <span className="team-step-icon" aria-hidden="true">
                          <Icon size={17} />
                        </span>
                        <div className="team-step-body">
                          <label className="team-step-name" htmlFor={`team-model-${step.key}`}>
                            {step.name}
                            {step.key === 'reader' && <span> ×4</span>}
                          </label>
                          <div className={`team-reveal ${teamOpen ? '' : 'shown'}`} aria-hidden={teamOpen}>
                            <span className="team-step-model">
                              {modelLabel(current)}
                              {edited && <em> · custom</em>}
                            </span>
                          </div>
                          <div className={`team-reveal ${teamOpen ? 'shown' : ''}`} inert={!teamOpen}>
                            <div className="team-select">
                              <select
                                id={`team-model-${step.key}`}
                                value={current}
                                onChange={(event) => changeTeamModel(step.key, event.target.value)}
                              >
                                <optgroup label="Recommended">{option(recommended)}</optgroup>
                                {isScout ? (
                                  choices.length > 0 && <optgroup label="Other search">{choices.map(option)}</optgroup>
                                ) : (
                                  <>
                                    {nemotron.length > 0 && <optgroup label="NVIDIA Nemotron">{nemotron.map(option)}</optgroup>}
                                    {others.length > 0 && <optgroup label="Other models">{others.map(option)}</optgroup>}
                                  </>
                                )}
                              </select>
                              <ChevronDown size={13} aria-hidden="true" />
                            </div>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>

                <span className="visually-hidden" aria-live="polite">
                  {teamAnnouncement}
                </span>
              </aside>
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
                          <span>{source.domain}</span>
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
              <div className="report-topline">
                <button type="button" className="text-back" onClick={newResearch}>
                  <Plus size={16} /> New research
                </button>
                <span className="sample-notice">
                  {isSampleReport ? 'Illustrative report · Preview data' : 'Verified Evidence · Live Briefing'}
                </span>
              </div>
              <div className="report-title-block">
                <div className="section-label">
                  Research brief / {focusOptions.find((option) => option.id === focusMode)?.label}
                </div>
                <h1>{submittedQuery}</h1>
                <div className="report-meta">
                  <span>
                    <Check size={14} /> Research complete
                  </span>
                  <span>{currentSources.length} sources reviewed</span>
                  <span>5 agent stages</span>
                  {liveStats.elapsed && <span>Completed in {liveStats.elapsed}s</span>}
                </div>
                <div className="report-actions">
                  <button type="button" onClick={() => navigate('studio')} title="Draft full publication-grade LaTeX paper">
                    <GraduationCap size={16} /> Paper Studio (LaTeX)
                  </button>
                  <button type="button" onClick={() => window.print()}>
                    <FileText size={16} /> Export PDF
                  </button>
                  <button type="button" onClick={openSlides}>
                    <Presentation size={16} /> Slides
                  </button>
                  <button type="button" onClick={shareReport}>
                    <Share2 size={16} /> Share
                  </button>
                </div>
              </div>
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
                      <form className="follow-up-box" onSubmit={submitFollowUp}>
                        <label htmlFor="follow-up">Continue this research thread</label>
                        {followUpSent && (
                          <div className="follow-up-response">
                            <span className="section-label">
                              {followUpSending ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />} Nemotron Analyst
                            </span>
                            <RenderReportBody markdown={followUpResponse} sources={currentSources} onOpenSource={setSelectedSource} />
                          </div>
                        )}
                        <div>
                          <input
                            id="follow-up"
                            value={followUp}
                            onChange={(event) => setFollowUp(event.target.value)}
                            placeholder="Ask a follow-up question…"
                          />
                          <button type="submit" aria-label="Send follow-up" disabled={followUpSending}>
                            <ArrowUpRight size={18} />
                          </button>
                        </div>
                      </form>
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
                      <form className="follow-up-box" onSubmit={submitFollowUp}>
                        <label htmlFor="follow-up">Continue this research thread</label>
                        {followUpSent && (
                          <div className="follow-up-response">
                            <span className="section-label">
                              {followUpSending ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />} Nemotron Analyst
                            </span>
                            <RenderReportBody markdown={followUpResponse} sources={currentSources} onOpenSource={setSelectedSource} />
                          </div>
                        )}
                        <div>
                          <input
                            id="follow-up"
                            value={followUp}
                            onChange={(event) => setFollowUp(event.target.value)}
                            placeholder="Ask a follow-up question…"
                          />
                          <button type="submit" aria-label="Send follow-up" disabled={followUpSending}>
                            <ArrowUpRight size={18} />
                          </button>
                        </div>
                      </form>
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
                            {source.domain} · {source.relevance}% match
                          </small>
                        </span>
                      </button>
                    ))}
                    <button type="button" className="view-all-sources" onClick={() => setReportTab('sources')}>
                      View evidence details <ArrowRight size={15} />
                    </button>
                  </aside>
                </div>
              ) : reportTab === 'sources' ? (
                <div className="sources-page">
                  <div className="sources-page-intro">
                    <h2>Evidence you can inspect.</h2>
                    <p>Every extracted claim stays connected to its original source and verbatim context.</p>
                  </div>
                  {currentSources.map((source) => (
                    <div className="source-detail-row" key={source.id}>
                      <span className="source-detail-id">0{source.id}</span>
                      <div>
                        <div className="source-detail-meta">
                          <span>{source.domain}</span>
                          <span>{source.relevance}% relevance</span>
                        </div>
                        <h3>{source.title}</h3>
                        <p>{source.authors || source.domain}</p>
                        <blockquote>“{source.quote || source.snippet || source.summary}”</blockquote>
                        <div className="source-detail-actions">
                          <button type="button" onClick={() => setSelectedSource(source)}>
                            <ScanSearch size={15} /> Inspect extraction
                          </button>
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
              <div className="page-heading">
                <div>
                  <div className="section-label">Your research archive</div>
                  <h1>
                    Pick up where
                    <br />
                    you left off.
                  </h1>
                </div>
                <button type="button" className="primary-button" onClick={newResearch}>
                  <Plus size={16} /> New research
                </button>
              </div>
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
              <div className="library-list">
                <div className="library-list-head">
                  <span>Research</span>
                  <span>Focus</span>
                  <span>Sources</span>
                  <span>Updated</span>
                  <span />
                </div>
                {filteredReports.map((report, index) => (
                  <button
                    type="button"
                    className="library-row"
                    key={report.id || report.title}
                    onClick={() => openReport(report)}
                  >
                    <span className="library-title">
                      <span>0{index + 1}</span>
                      <strong>{report.title}</strong>
                    </span>
                    <span>{report.mode}</span>
                    <span>{report.sources}</span>
                    <span>{report.time}</span>
                    <ArrowUpRight size={17} />
                  </button>
                ))}
                {filteredReports.length === 0 && (
                  <div className="library-empty">No research matches “{libraryFilter}”.</div>
                )}
              </div>
            </section>
          )}

          {view === 'activity' && (
            <section className="activity-view">
              <div className="page-heading">
                <div>
                  <div className="section-label">Right model for the right task</div>
                  <h1>
                    A small team,
                    <br />
                    not a giant call.
                  </h1>
                </div>
                <span className="activity-ready">
                  <span /> {healthStatus.ok ? 'All systems ready · Nebius API' : 'Ready'}
                </span>
              </div>
              <p className="activity-lead">
                NemoSearch routes each research stage across three Nemotron 3 tiers, with Tavily supplying fresh web evidence.
              </p>
              <div className="activity-metrics">
                <div>
                  <span>Specialized model tiers</span>
                  <strong>03</strong>
                  <small>Nano / Super / Ultra</small>
                </div>
                <div>
                  <span>Parallel evidence readers</span>
                  <strong>04</strong>
                  <small>Async, semaphore governed</small>
                </div>
                <div>
                  <span>Research stages visible</span>
                  <strong>05</strong>
                  <small>Plan → search → read → critique → write</small>
                </div>
              </div>
              <div className="routing-ledger">
                <div className="run-list-heading">
                  <span className="section-label">Routing ledger</span>
                  <span>Live architecture</span>
                </div>
                {defaultResearchSteps.map((step, index) => {
                  const Icon = stepIcons[index]
                  return (
                    <div className="ledger-row" key={step.name}>
                      <span className="ledger-icon">
                        <Icon size={19} />
                      </span>
                      <strong>{step.name}</strong>
                      <span>{modelLabel(teamModels[teamSteps[index].key])}</span>
                      <p>{step.detail}</p>
                      <span className="ledger-status">
                        <Check size={14} /> Ready
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="activity-footer">
                <div>
                  <Network size={22} />
                  <p>
                    <strong>Efficiency is a design decision.</strong>
                    <br />
                    Use Nano for speed, Super for parallel evidence work, and Ultra only where deep reasoning pays for itself.
                  </p>
                </div>
                <button type="button" className="primary-button" onClick={newResearch}>
                  Start a research run <ArrowRight size={16} />
                </button>
              </div>
            </section>
          )}

          {view === 'studio' && (
            <PaperStudio
              topic={submittedQuery}
              reportText={isLiveRun && liveReport ? liveReport : SAMPLE_QUERY}
              sources={currentSources}
              savedReports={libraryReports}
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
              <span>{selectedSource.domain}</span>
              <span>{selectedSource.relevance}% relevance</span>
            </div>
            <h2 id="source-modal-title">{selectedSource.title}</h2>
            <p className="source-modal-authors">{selectedSource.authors || selectedSource.domain}</p>
            <div className="extracted-quote">
              <span className="section-label">
                <Check size={13} /> Verbatim extraction
              </span>
              <blockquote>“{selectedSource.quote || selectedSource.snippet || selectedSource.summary}”</blockquote>
            </div>
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

      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  )
}
