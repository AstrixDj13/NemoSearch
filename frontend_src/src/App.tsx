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
  Paperclip,
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
const viewNames: Record<View, string> = {
  home: 'New research',
  running: 'Research in progress',
  report: 'Research brief',
  library: 'Library',
  activity: 'Agent activity',
}

const defaultSlides: SlideItem[] = [
  { num: '01', title: 'The decision', bullets: ['Dense vs. sparse inference in one operational frame.'] },
  { num: '02', title: 'Why sparse scaling matters', bullets: ['Capacity, active parameters, and conditional compute.'] },
  { num: '03', title: 'The serving constraint', bullets: ['Routing, memory pressure, and real-world utilization.'] },
  { num: '04', title: 'Beyond the architecture', bullets: ['IO-aware kernels and the complete serving system.'] },
  { num: '05', title: 'Recommendation', bullets: ['Benchmark the workload, not the parameter count.'] },
]

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

function InlineContent({ text, sourceMap, onOpenSource }: { text: string; sourceMap: Map<number, Source>; onOpenSource: (s: Source) => void }) {
  // Parse inline citations e.g. [1], [2] as well as bold **text**
  const citationParts = text.split(/(\[\d+\])/g)
  return (
    <>
      {citationParts.map((part, pIdx) => {
        const citeMatch = part.match(/^\[(\d+)\]$/)
        if (citeMatch) {
          const id = parseInt(citeMatch[1], 10)
          return <Citation key={pIdx} id={id} source={sourceMap.get(id)} onOpen={onOpenSource} />
        }
        // Parse bold **text**
        const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
        return boldParts.map((bPart, bIdx) => {
          if (bPart.startsWith('**') && bPart.endsWith('**')) {
            return <strong key={`${pIdx}-${bIdx}`}>{bPart.slice(2, -2)}</strong>
          }
          return bPart
        })
      })}
    </>
  )
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

  const sections = useMemo(() => {
    if (!markdown) return []
    const lines = markdown.split('\n')
    const parsed: { type: 'summary' | 'heading' | 'p' | 'list' | 'conclusion'; title?: string; items?: string[]; content?: string }[] = []
    let currentParagraph: string[] = []

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        const text = currentParagraph.join(' ').trim()
        if (text) {
          parsed.push({ type: 'p', content: text })
        }
        currentParagraph = []
      }
    }

    let i = 0
    while (i < lines.length) {
      const line = lines[i].trim()

      if (line.startsWith('# ')) {
        flushParagraph()
        // Skip title as it's shown in header
        i++
        continue
      }

      if (line.startsWith('**TL;DR**') || line.startsWith('### TL;DR') || line.toLowerCase().startsWith('## tl;dr')) {
        flushParagraph()
        i++
        const summaryBullets: string[] = []
        while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
          summaryBullets.push(lines[i].trim().replace(/^[-*]\s+/, ''))
          i++
        }
        parsed.push({ type: 'summary', items: summaryBullets })
        continue
      }

      if (line.startsWith('## ')) {
        flushParagraph()
        const headingText = line.replace(/^##\s+/, '').replace(/\*\*/g, '')
        if (headingText.toLowerCase().includes('bottom line') || headingText.toLowerCase().includes('conclusion')) {
          i++
          const conclusionLines: string[] = []
          while (i < lines.length && !lines[i].trim().startsWith('## ')) {
            if (lines[i].trim()) conclusionLines.push(lines[i].trim())
            i++
          }
          parsed.push({ type: 'conclusion', content: conclusionLines.join(' ') })
          continue
        } else {
          parsed.push({ type: 'heading', title: headingText })
          i++
          continue
        }
      }

      if (line.startsWith('- ') || line.startsWith('* ')) {
        flushParagraph()
        const listItems: string[] = []
        while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
          listItems.push(lines[i].trim().replace(/^[-*]\s+/, ''))
          i++
        }
        parsed.push({ type: 'list', items: listItems })
        continue
      }

      if (line === '') {
        flushParagraph()
      } else {
        currentParagraph.push(line)
      }
      i++
    }
    flushParagraph()
    return parsed
  }, [markdown])

  return (
    <article className="report-article">
      {sections.map((sec, idx) => {
        if (sec.type === 'summary') {
          return (
            <section className="answer-summary" key={idx}>
              <div className="section-label">The short answer</div>
              {sec.items && sec.items.length > 0 ? (
                <div style={{ marginTop: '14px', display: 'grid', gap: '8px' }}>
                  {sec.items.map((it, iIdx) => (
                    <p key={iIdx} style={{ margin: 0 }}>
                      • <InlineContent text={it} sourceMap={sourceMap} onOpenSource={onOpenSource} />
                    </p>
                  ))}
                </div>
              ) : (
                <p>
                  <InlineContent text={sec.content || ''} sourceMap={sourceMap} onOpenSource={onOpenSource} />
                </p>
              )}
            </section>
          )
        }

        if (sec.type === 'heading') {
          return (
            <h2 key={idx} style={{ marginTop: '32px' }}>
              {sec.title}
            </h2>
          )
        }

        if (sec.type === 'list') {
          return (
            <ul key={idx} style={{ margin: '0 0 16px 20px', color: 'oklch(0.31 0.006 260)', lineHeight: '1.75' }}>
              {sec.items?.map((it, lIdx) => (
                <li key={lIdx} style={{ marginBottom: '6px' }}>
                  <InlineContent text={it} sourceMap={sourceMap} onOpenSource={onOpenSource} />
                </li>
              ))}
            </ul>
          )
        }

        if (sec.type === 'conclusion') {
          return (
            <div className="report-conclusion" key={idx} style={{ marginTop: '32px' }}>
              <span className="section-label">Bottom line</span>
              <p>
                <InlineContent text={sec.content || ''} sourceMap={sourceMap} onOpenSource={onOpenSource} />
              </p>
            </div>
          )
        }

        return (
          <p key={idx}>
            <InlineContent text={sec.content || ''} sourceMap={sourceMap} onOpenSource={onOpenSource} />
          </p>
        )
      })}
    </article>
  )
}

export default function App() {
  const [view, setView] = useState<View>('home')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState(SAMPLE_QUERY)
  const [focusMode, setFocusMode] = useState<FocusMode>('web')
  const [deepMode, setDeepMode] = useState(true)
  const [runStep, setRunStep] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState(false)
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
      { name: 'Planner', model: 'Nemotron 3 Nano · 30B', detail: 'Decomposing question into research paths...' },
      { name: 'Scout', model: 'Tavily AI Search', detail: 'Preparing live search across primary sources...' },
      { name: 'Readers', model: 'Nemotron 3 Super · 120B', detail: 'Standing by for parallel evidence extraction...' },
      { name: 'Critic', model: 'Nemotron 3 Nano · 30B', detail: 'Queued to verify coverage & close gaps...' },
      { name: 'Lead analyst', model: 'Nemotron 3 Ultra · 550B', detail: 'Queued for rigorous cited synthesis...' },
    ])
    setView('running')

    // Connect to real FastAPI SSE endpoint
    const url = `/api/research?q=${encodeURIComponent(cleanQuery)}&depth=${deepMode ? 'deep' : 'quick'}&focus=${focusMode}`
    let accumulatedReport = ''
    let accumulatedReasoning = ''
    let collectedSources: Source[] = []

    try {
      const es = new EventSource(url)
      activeEventSource.current = es

      es.onmessage = (event) => {
        try {
          if (!event.data) return
          const data = JSON.parse(event.data)

          if (data.type === 'stage') {
            const stageName = data.stage
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
            const src = data.source
            collectedSources = [
              ...collectedSources,
              {
                id: src.id,
                title: src.title || 'Untitled source',
                authors: src.domain || 'Web source',
                domain: src.domain || 'web',
                url: src.url || '#',
                relevance: 85,
                quote: src.snippet || '',
                snippet: src.snippet || '',
              },
            ]
            setLiveSources([...collectedSources])
          } else if (data.type === 'note') {
            collectedSources = collectedSources.map((s) => {
              if (s.id === data.id) {
                return {
                  ...s,
                  relevance: data.relevance ? Math.round(data.relevance * 10) : s.relevance,
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
              const fullSources: Source[] = Object.values(data.sources).map((s: any) => ({
                id: s.id,
                title: s.title,
                authors: s.domain,
                domain: s.domain,
                url: s.url,
                relevance: s.relevance ? Math.round(s.relevance * 10) : 88,
                quote: s.quote || s.summary || '',
                summary: s.summary,
              }))
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

  const useSample = (value: string) => {
    setQuery(value)
    searchRef.current?.focus()
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
        body: JSON.stringify({ topic: submittedQuery, report: reportTextToUse }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.slides && Array.isArray(data.slides)) {
          setSlidesData(
            data.slides.map((s: any, idx: number) => ({
              num: `0${idx + 1}`,
              title: s.title || `Key Point ${idx + 1}`,
              bullets: s.bullets || [],
            }))
          )
        }
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

    const sourcesObj: Record<number, any> = {}
    currentSources.forEach((s) => {
      sourcesObj[s.id] = { id: s.id, title: s.title, url: s.url, domain: s.domain, quote: s.quote }
    })

    try {
      const response = await fetch('/api/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: cleanFollowUp,
          prior_question: submittedQuery,
          prior_report: isLiveRun && liveReport ? liveReport : SAMPLE_QUERY,
          sources: sourcesObj,
        }),
      })

      if (!response.body) {
        setFollowUpResponse('Unable to stream response from backend.')
        setFollowUpSending(false)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.type === 'answer') {
                if (accumulated === '') setFollowUpResponse('')
                accumulated += data.delta
                setFollowUpResponse(accumulated)
              }
            } catch {
              // Ignore non-json
            }
          }
        }
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
    <div className="app-shell">
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
          <IconButton label="Close navigation" className="mobile-close" onClick={() => setSidebarOpen(false)}>
            <X size={19} />
          </IconButton>
        </div>
        <button type="button" className="new-research-button" onClick={newResearch}>
          <Plus size={17} /> New research <span>⌘ K</span>
        </button>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            type="button"
            className={view === 'home' || view === 'running' || view === 'report' ? 'active' : ''}
            onClick={newResearch}
          >
            <Search size={17} /> Research
          </button>
          <button
            type="button"
            className={view === 'library' ? 'active' : ''}
            onClick={() => navigate('library')}
          >
            <Library size={17} /> Library
          </button>
          <button
            type="button"
            className={view === 'activity' ? 'active' : ''}
            onClick={() => navigate('activity')}
          >
            <Activity size={17} /> Agent activity <span className="nav-live" />
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
        <button type="button" className="ensemble-status" onClick={() => navigate('activity')}>
          <span className="status-orbit">
            <span />
          </span>
          <span>
            <strong>Nemotron 3 ensemble</strong>
            <small>3 model tiers · ready</small>
          </span>
          <ArrowUpRight size={15} />
        </button>
      </aside>

      <div className="workspace">
        <header className="topbar">
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
            <span className="workspace-avatar">NS</span>
          </div>
        </header>

        <main className={`main-content view-${view}`}>
          {view === 'home' && (
            <div className="home-grid">
              <section className="home-primary">
                <div className="home-heading">
                  <div className="section-label">Autonomous research, made visible</div>
                  <h1>
                    Research without
                    <br />
                    the black box.
                  </h1>
                  <p>A focused team of Nemotron agents plans, searches, reads, and cites—so you can inspect every step.</p>
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
                        <Paperclip size={18} />
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

                <div className="focus-modes" aria-label="Research focus">
                  {focusOptions.map((option) => {
                    const Icon = option.icon
                    return (
                      <button
                        type="button"
                        key={option.id}
                        className={focusMode === option.id ? 'selected' : ''}
                        aria-pressed={focusMode === option.id}
                        onClick={() => setFocusMode(option.id)}
                      >
                        <Icon size={16} />
                        {option.label}
                      </button>
                    )
                  })}
                </div>

                <div className="sample-section">
                  <div className="sample-heading">
                    <span className="section-label">Start with a research path</span>
                    <span>3 curated prompts</span>
                  </div>
                  {[
                    SAMPLE_QUERY,
                    'Map the emerging stack for real-time multimodal agents',
                    'How do inference costs change AI product margins?',
                  ].map((sample, index) => (
                    <button type="button" className="sample-row" key={sample} onClick={() => useSample(sample)}>
                      <span className="sample-index">0{index + 1}</span>
                      <span>{sample}</span>
                      <ArrowRight size={17} />
                    </button>
                  ))}
                </div>
              </section>

              <aside className="research-team" aria-label="Research model routing">
                <div className="team-heading">
                  <span className="section-label">Your research team</span>
                  <span className="live-label">
                    <span /> Ready
                  </span>
                </div>
                <p>
                  Specialists at every step.
                  <br />
                  One shared evidence thread.
                </p>
                <div className="team-route">
                  {defaultResearchSteps.map((step, index) => {
                    const Icon = stepIcons[index]
                    return (
                      <div className="team-node" key={step.name}>
                        <div className="team-node-icon">
                          <Icon size={17} />
                        </div>
                        <div>
                          <strong>
                            {step.name}
                            {step.name === 'Readers' && <span> ×4</span>}
                          </strong>
                          <small>{step.model}</small>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="team-note">
                  <Network size={17} />
                  <span>
                    Right model for the right task.
                    <br />
                    <strong>Nothing more. Nothing less.</strong>
                  </span>
                </div>
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
                            <p>{followUpResponse}</p>
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
                            <p>{followUpResponse}</p>
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
                      <span>{step.model}</span>
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
