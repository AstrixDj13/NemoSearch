import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Columns2,
  Copy,
  Download,
  FileCode,
  FolderArchive,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  Maximize2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Upload,
  WrapText,
  X,
} from 'lucide-react'
import { api } from '../api'
import { defaultTemplates } from '../data'
import type { PaperChatMessage, PaperDoc, PaperSummary, PaperTemplate, Project, SavedReport } from '../data'

interface PaperStudioProps {
  /** Research to open first: the run that just finished, or the report being read */
  reportId: string | null
  savedReports?: SavedReport[]
  projects?: Project[]
  activeFileId?: string
  onSelectFile?: (fileId: string) => void
  onNotify: (msg: string) => void
}

// Requests that suit any paper; the co-author applies them to whatever this paper is about
const QUICK_PROMPTS = [
  'Tighten the abstract',
  'Add a table comparing the cited studies',
  'Expand the related work',
  'Strengthen the limitations section',
  'Make the paper more concise',
]
// How often an open paper checks for other people's messages and edits
const POLL_MS = 3000
// Typing pauses this long before an edit is saved for everyone
const SAVE_DELAY_MS = 1500

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.')
const summaryOf = (d: PaperDoc): PaperSummary => ({
  id: d.id, reportId: d.reportId, projectId: d.projectId, title: d.title, question: d.question, templateId: d.templateId,
  version: d.version, hasDraft: d.hasDraft, busy: d.busy, updatedAt: d.updatedAt,
})

/** Authors, year and title of each BibTeX entry, for the preview's reference list */
function bibEntries(bibtex: string) {
  return bibtex
    .split(/\n(?=@)/)
    .map((entry) => {
      const field = (name: string) => entry.match(new RegExp(`${name}\\s*=\\s*\\{+([^}]*)\\}`, 'i'))?.[1].trim() || ''
      return { key: entry.match(/@\w+\{([^,]+),/)?.[1] || '', title: field('title'), authors: field('author').replace(/ and /g, ', '), year: field('year') }
    })
    .filter((e) => e.key)
}

export default function PaperStudio({
  reportId,
  savedReports = [],
  projects = [],
  activeFileId: activeFileIdProp = 'main.tex',
  onSelectFile,
  onNotify,
}: PaperStudioProps) {
  const [templates, setTemplates] = useState<PaperTemplate[]>(defaultTemplates)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('neurips')
  const [installModalOpen, setInstallModalOpen] = useState<boolean>(false)
  // Which panes are visible: both side by side, or one maximized with the other minimized
  const [layout, setLayout] = useState<'split' | 'editor' | 'preview'>('split')
  const [wrap, setWrap] = useState(false)

  // The template dialog takes focus when it opens and gives it back to whatever opened it
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (installModalOpen) {
      returnFocusRef.current = document.activeElement as HTMLElement | null
      firstFieldRef.current?.focus()
    } else {
      returnFocusRef.current?.focus()
      returnFocusRef.current = null
    }
  }, [installModalOpen])

  // The research the paper is written from. Opening Paper Studio from a report selects that report.
  const [selectedReportId, setSelectedReportId] = useState<string>(reportId || '')
  const [prevReportId, setPrevReportId] = useState(reportId)
  if (reportId !== prevReportId) {
    setPrevReportId(reportId)
    if (reportId) setSelectedReportId(reportId)
  }
  const selectedReport = savedReports.find((r) => r.id === selectedReportId)
  const project = projects.find((p) => p.id === selectedReport?.projectId)

  // The shared paper for that research, as the server has it. Papers are made on first draft or first message.
  const [papers, setPapers] = useState<PaperSummary[]>([])
  const [paper, setPaper] = useState<PaperDoc | null>(null)
  const summary = papers.find((p) => p.reportId === selectedReportId)
  const shownPaper = paper && paper.reportId === selectedReportId ? paper : null
  const paperId = shownPaper?.id ?? summary?.id

  // The editor's text. It follows the server unless this person has edits that are not saved yet.
  const [latexCode, setLatexCode] = useState<string>('')
  const [bibtexCode, setBibtexCode] = useState<string>('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)
  const textRef = useRef({ latex: '', bibtex: '' })
  // The paper version the editor's text is based on; -1 means "take whatever the server has"
  const baseVersion = useRef(-1)

  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [isSending, setIsSending] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Active file selection (synchronized with main app left sidebar)
  const [internalActiveFile, setInternalActiveFile] = useState<string>(activeFileIdProp)
  const activeFileId = activeFileIdProp || internalActiveFile

  const setActiveFile = (id: string) => {
    setInternalActiveFile(id)
    onSelectFile?.(id)
  }

  // Line numbers scrolling sync refs
  const gutterRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Custom template form states
  const [customName, setCustomName] = useState('')
  const [customVenue, setCustomVenue] = useState('')
  const [customDocClass, setCustomDocClass] = useState('\\documentclass[11pt,a4paper]{article}')
  const [customPreamble, setCustomPreamble] = useState('\\usepackage{amsmath,amssymb,booktabs,graphicx,hyperref}')

  const markDirty = (on: boolean) => {
    dirtyRef.current = on
    setDirty(on)
  }

  /** Takes in what the server sent: new messages are added, and the text follows unless there are unsaved edits. */
  const applyPaper = useCallback((doc: PaperDoc, replaceMessages = false) => {
    setPaper((prev) => {
      const keep = !replaceMessages && prev?.id === doc.id ? prev.messages : []
      const known = new Set(keep.map((m) => m.id))
      return { ...doc, messages: [...keep, ...doc.messages.filter((m) => !known.has(m.id))] }
    })
    setPapers((prev) => [summaryOf(doc), ...prev.filter((p) => p.id !== doc.id)])
    if (doc.version !== baseVersion.current && !dirtyRef.current) {
      baseVersion.current = doc.version
      textRef.current = { latex: doc.latex, bibtex: doc.bibtex }
      setLatexCode(doc.latex)
      setBibtexCode(doc.bibtex)
      setSelectedTemplateId(doc.templateId)
    }
  }, [])

  // Fetch installed templates and the papers this account can open
  useEffect(() => {
    fetch('/api/paper/templates')
      .then((res) => res.json())
      .then((data) => {
        if (data.templates && Array.isArray(data.templates)) {
          setTemplates(data.templates)
        }
      })
      .catch(() => {})
    api.listPapers().then(setPapers).catch(() => {})
  }, [])

  // Open the paper for the selected research
  useEffect(() => {
    if (!paperId) return
    let live = true
    api
      .getPaper(paperId)
      .then((doc) => {
        if (!live) return
        baseVersion.current = -1
        dirtyRef.current = false
        setDirty(false)
        applyPaper(doc, true)
      })
      .catch((e) => live && onNotify(errorText(e)))
    return () => {
      live = false
    }
    // onNotify changes identity on every render of the app; reopening is only about which paper
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, applyPaper])

  // Everyone with the paper open sees each other's messages, edits and the co-author's work within a few seconds
  const lastMessageAt = shownPaper?.messages.at(-1)?.createdAt ?? 0
  const lastSeen = useRef(0)
  useEffect(() => {
    lastSeen.current = lastMessageAt
  }, [lastMessageAt])
  useEffect(() => {
    if (!shownPaper?.id) return
    const id = shownPaper.id
    const timer = window.setInterval(() => {
      if (document.hidden) return
      api.getPaper(id, lastSeen.current).then((doc) => applyPaper(doc)).catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [shownPaper?.id, applyPaper])

  // Until this research has a paper, watch for a collaborator starting one
  useEffect(() => {
    if (!selectedReportId || paperId) return
    const timer = window.setInterval(() => {
      if (!document.hidden) api.listPapers().then(setPapers).catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [selectedReportId, paperId])

  // Keep the newest message in view
  const messageCount = shownPaper?.messages.length ?? 0
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messageCount])

  const busy = shownPaper?.busy ?? null
  const coauthorWorking = isGenerating || isSending || busy !== null

  // Save typing for everyone after a short pause
  useEffect(() => {
    if (!dirty || !shownPaper || coauthorWorking) return
    const id = shownPaper.id
    const timer = window.setTimeout(async () => {
      const sent = { ...textRef.current }
      setSaving(true)
      try {
        const doc = await api.editPaper(id, baseVersion.current, sent)
        baseVersion.current = doc.version
        if (textRef.current.latex === sent.latex && textRef.current.bibtex === sent.bibtex) markDirty(false)
        applyPaper(doc)
      } catch (e) {
        // Someone else changed the paper first (or the co-author is revising it): load theirs
        onNotify(errorText(e))
        markDirty(false)
        baseVersion.current = -1
        api.getPaper(id).then((doc) => applyPaper(doc, true)).catch(() => {})
      } finally {
        setSaving(false)
      }
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, latexCode, bibtexCode, shownPaper?.id, coauthorWorking, applyPaper])

  /** The paper for the selected research, made on first use */
  const ensurePaper = async (): Promise<PaperDoc> => {
    if (shownPaper) return shownPaper
    const doc = await api.openPaper(selectedReportId, selectedTemplateId)
    baseVersion.current = -1
    applyPaper(doc, true)
    return doc
  }

  const generatePaper = async () => {
    if (!selectedReportId) return
    if (shownPaper?.hasDraft && !window.confirm('Re-drafting replaces the whole paper, for everyone working on it. Continue?')) return
    setIsGenerating(true)
    onNotify('The co-author is drafting the paper from your research…')
    try {
      const opened = await ensurePaper()
      markDirty(false)
      const doc = await api.draftPaper(opened.id, selectedTemplateId)
      applyPaper(doc)
      setActiveFile('main.tex')
      onNotify(doc.hasDraft ? 'Draft ready. The co-author left you some questions in the chat.' : 'The draft did not finish; see the chat.')
    } catch (e) {
      onNotify(errorText(e))
    } finally {
      setIsGenerating(false)
    }
  }

  const sendMessage = async (text = chatInput) => {
    const body = text.trim()
    if (!body || !selectedReportId) return
    setIsSending(true)
    setChatInput('')
    try {
      const opened = await ensurePaper()
      applyPaper(await api.sendPaperMessage(opened.id, body))
    } catch (e) {
      setChatInput(body)
      onNotify(errorText(e))
    } finally {
      setIsSending(false)
    }
  }

  const changeTemplate = (id: string) => {
    setSelectedTemplateId(id)
    if (shownPaper && !coauthorWorking) {
      api.editPaper(shownPaper.id, shownPaper.version, { templateId: id }).catch(() => {})
    }
  }

  const handleInstallCustom = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customName.trim()) return

    try {
      const res = await fetch('/api/paper/install_template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: customName.trim(),
          venue: customVenue.trim() || 'Custom Journal',
          doc_class: customDocClass.trim(),
          preamble: customPreamble.trim(),
        }),
      })

      if (res.ok) {
        const data = await res.json()
        if (data.template) {
          setTemplates((prev) => [...prev, data.template])
          changeTemplate(data.template.id)
          setInstallModalOpen(false)
          onNotify(`Installed template "${customName}". It applies the next time you draft.`)
        }
      }
    } catch {
      onNotify('Could not install template. Check backend.')
    }
  }

  const topicTitle = selectedReport?.title || shownPaper?.title || ''
  const latexText = shownPaper ? latexCode : ''
  const bibText = shownPaper ? bibtexCode : ''
  const references = bibEntries(bibText)

  const handleDownloadZip = async () => {
    try {
      const res = await fetch('/api/paper/download_zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topicTitle || 'research_paper',
          latex: latexText,
          bibtex: bibText,
        }),
      })

      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${(topicTitle || 'paper').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 60)}_overleaf_package.zip`
        a.click()
        URL.revokeObjectURL(url)
        onNotify('Complete Overleaf project package (.zip) downloaded!')
      } else {
        throw new Error('Download failed')
      }
    } catch {
      onNotify('Download failed. Copy LaTeX and BibTeX code directly.')
    }
  }

  // sections/ shows the paper's first four sections in order, whatever their headings
  const sectionChunks = latexText.match(/\\section\*?\{[\s\S]*?(?=\\section\*?\{|\\bibliographystyle|\\bibliography\{|\\end\{document\}|$)/g) ?? []
  const nthSection = (i: number) => sectionChunks[i]?.trim() || `% This paper has fewer than ${i + 1} sections.`

  const currentTpl = templates.find((t) => t.id === selectedTemplateId) || templates[0]
  const tplStyleName = currentTpl.id === 'neurips' ? 'neurips_2024.sty' : `${currentTpl.id}.cls`

  const [introText, relatedText, methodText, expText] = [0, 1, 2, 3].map(nthSection)

  const styleText = `% ${currentTpl.name} Conference / Journal Style Definitions
\\NeedsTeXFormat{LaTeX2e}
\\ProvidesPackage{${currentTpl.id}}[2024/02/01 NemoSearch Official Venue Package]
\\RequirePackage{amsmath,amssymb,amsfonts}
\\RequirePackage{graphicx}
\\RequirePackage{booktabs}
\\RequirePackage{hyperref}
\\typeout{Loaded ${currentTpl.name} LaTeX macros}
`

  const readmeText = `# ${topicTitle} - LaTeX Manuscript Package
Generated autonomously by NemoSearch (NVIDIA Nemotron 3 Ensemble + OpenAlex/arXiv).

## Overleaf Project File Tree
- \`main.tex\`: Compilable master LaTeX manuscript.
- \`references.bib\`: Grounded BibTeX reference database (${references.length} entries).
- \`sections/\`: Modular section files:
  - \`01_introduction.tex\`
  - \`02_related_work.tex\`
  - \`03_methodology.tex\`
  - \`04_experiments.tex\`
- \`styles/\`: Venue template macros and classes (\`${tplStyleName}\`).
- \`figures/\`: Visual architecture and benchmark diagrams.
- \`README.md\`: Compilation and Overleaf submission instructions.

## Compiling Instructions
Compile with standard TeX distributions or Overleaf:
\`\`\`bash
pdflatex main.tex
bibtex main
pdflatex main.tex
pdflatex main.tex
\`\`\`
Or drag this zip file directly into Overleaf via 'New Project -> Upload Project'.
`

  // Get active file content
  const getActiveFileContent = (): string => {
    if (activeFileId === 'main.tex') return latexText
    if (activeFileId === 'references.bib') return bibText
    if (activeFileId === 'README.md') return readmeText
    if (activeFileId === '01_introduction.tex') return introText
    if (activeFileId === '02_related_work.tex') return relatedText
    if (activeFileId === '03_methodology.tex') return methodText
    if (activeFileId === '04_experiments.tex') return expText
    if (activeFileId === tplStyleName || activeFileId.endsWith('.sty') || activeFileId.endsWith('.cls')) {
      return styleText
    }
    return latexCode
  }

  const handleActiveFileChange = (newVal: string) => {
    if (activeFileId === 'main.tex') {
      setLatexCode(newVal)
      textRef.current = { ...textRef.current, latex: newVal }
    } else if (activeFileId === 'references.bib') {
      setBibtexCode(newVal)
      textRef.current = { ...textRef.current, bibtex: newVal }
    } else {
      return
    }
    markDirty(true)
  }

  const syncScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  const activeContent = getActiveFileContent()
  const lineCount = activeContent ? activeContent.split('\n').length : 1
  const lineNumbers = Array.from({ length: Math.max(1, lineCount) }, (_, i) => i + 1)

  const handleCopyCurrentFile = () => {
    navigator.clipboard.writeText(activeContent)
    onNotify(`Copied ${activeFileId} to clipboard.`)
  }

  const handleDownloadCurrentFile = () => {
    const ext = activeFileId.split('.').pop() || 'txt'
    const mimeType = ext === 'tex' ? 'text/x-tex' : ext === 'bib' ? 'text/plain' : 'text/plain'
    const blob = new Blob([activeContent], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = activeFileId
    a.click()
    URL.revokeObjectURL(url)
    onNotify(`Downloaded ${activeFileId}`)
  }

  const isImageFile = activeFileId.endsWith('.png') || activeFileId.endsWith('.jpg') || activeFileId.endsWith('.pdf')

  // Dynamic LaTeX document parser for the right-hand Formatted Manuscript Preview
  const parseDocumentForPreview = () => {
    const titleMatch = latexText.match(/\\title\{([^}]+)\}/)
    const headline = titleMatch ? titleMatch[1].replace(/\\\\/g, ' ').replace(/\\textbf\{([^}]+)\}/g, '$1').trim() : topicTitle

    const abstractMatch = latexText.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/)
    const abstractText = abstractMatch ? inlineLatex(abstractMatch[1].trim()) : ''

    const secRegex = /\\section\*?\{([^}]+)\}([\s\S]*?)(?=\\section\*?\{|\\begin\{thebibliography\}|\\bibliography|\\end\{document\}|$)/g
    const sections: { title: string; body: string }[] = []
    let match
    while ((match = secRegex.exec(latexText)) !== null) {
      sections.push({
        title: match[1].trim(),
        body: match[2].trim(),
      })
    }

    return { headline, abstractText, sections }
  }

  const previewDoc = parseDocumentForPreview()

  const hasDraft = latexText.trim().length > 0
  const editable = activeFileId === 'main.tex' || activeFileId === 'references.bib'
  const fileKind = activeFileId.endsWith('.tex')
    ? 'LaTeX'
    : activeFileId.endsWith('.bib')
      ? 'BibTeX'
      : activeFileId.endsWith('.md')
        ? 'Markdown'
        : activeFileId.endsWith('.png')
          ? 'Figure'
          : 'Style'
  const folder = /^0\d_/.test(activeFileId) ? 'sections/' : activeFileId.endsWith('.png') ? 'figures/' : /\.(sty|cls)$/.test(activeFileId) ? 'styles/' : ''

  // Pane controls: each pane can take the full width; the other collapses to a strip that restores the split
  const paneButtons = (pane: 'editor' | 'preview', name: string) => {
    const other = pane === 'editor' ? 'preview' : 'editor'
    return layout === pane ? (
      <button type="button" className="pane-control" onClick={() => setLayout('split')} aria-label={`Restore split view (show the ${other} again)`} title="Restore split view">
        <Columns2 size={16} aria-hidden="true" />
        <span>Split view</span>
      </button>
    ) : (
      <button type="button" className="pane-control icon" onClick={() => setLayout(pane)} aria-label={`Maximize ${name}`} title={`Maximize ${name}`}>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
    )
  }
  const minimizedPane = (pane: 'editor' | 'preview', name: string) => (
    <section className="studio-pane minimized" aria-label={`${name} (minimized)`}>
      <button type="button" className="pane-restore" onClick={() => setLayout('split')}>
        {pane === 'editor' ? <FileCode size={16} aria-hidden="true" /> : <Layers size={16} aria-hidden="true" />}
        <span>Show {name}</span>
      </button>
    </section>
  )

  return (
    <div className="paper-studio-container">
      {/* Same heading pattern as Library; the actions follow the fields they act on */}
      <header>
        <div className="page-heading">
          <div>
            <h1>Paper Studio</h1>
          </div>
        </div>
        <p className="page-description">Draft a LaTeX paper and BibTeX references from your verified research, then steer the co-author.</p>
      </header>

      <div className="studio-settings">
        <div className="studio-field">
          <label htmlFor="topic-select">Research</label>
          <select id="topic-select" value={selectedReportId} onChange={(e) => setSelectedReportId(e.target.value)} aria-describedby="topic-hint">
            <option value="" disabled>
              {savedReports.length ? 'Choose the research to write from…' : 'No saved research yet'}
            </option>
            {savedReports.map((r) => {
              const inProject = projects.find((p) => p.id === r.projectId)
              return (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {inProject ? ` · ${inProject.name}` : ''}
                </option>
              )
            })}
          </select>
          <p className="studio-field-hint" id="topic-hint">
            {!savedReports.length
              ? 'Run a research first; Paper Studio writes from its brief and sources.'
              : !selectedReportId
                ? 'The paper is written from this research, its sources, and its project.'
                : project
                  ? `Shared with everyone in ${project.name}${project.work ? `, a collaboration on “${project.work.title}”` : ''}.`
                  : 'Only you can see this paper. Move the research into a project to write it with others.'}
          </p>
        </div>
        <div className="studio-field">
          <label htmlFor="template-select">Venue template</label>
          <select
            id="template-select"
            value={selectedTemplateId}
            onChange={(e) => {
              const nextId = e.target.value
              if (nextId === 'custom_install_action') {
                setInstallModalOpen(true)
              } else {
                changeTemplate(nextId)
              }
            }}
          >
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
              </option>
            ))}
            <option value="custom_install_action">Install a custom template…</option>
          </select>
        </div>
      </div>

      <div className="studio-actions">
        <button type="button" className="studio-btn" onClick={() => setInstallModalOpen(true)}>
          <Upload size={16} aria-hidden="true" /> Install template
        </button>
        <button
          type="button"
          className={`studio-btn ${hasDraft ? '' : 'studio-btn-primary'}`}
          onClick={generatePaper}
          disabled={!selectedReportId || coauthorWorking}
        >
          {isGenerating ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
          {isGenerating ? 'Drafting…' : hasDraft ? 'Re-draft paper' : 'Draft paper'}
        </button>
        <button type="button" className={`studio-btn ${hasDraft ? 'studio-btn-primary' : ''}`} onClick={handleDownloadZip} disabled={!hasDraft}>
          <FolderArchive size={16} aria-hidden="true" /> Download .zip
        </button>
        {shownPaper && (
          <span className="studio-save-state" role="status">
            {saving ? 'Saving…' : dirty ? 'Unsaved changes' : hasDraft ? `Saved · version ${shownPaper.version}` : ''}
          </span>
        )}
      </div>

      <section className="studio-coauthor-card" aria-labelledby="coauthor-title">
        <div className="coauthor-header">
          <h2 id="coauthor-title">
            <Sparkles size={15} aria-hidden="true" /> Co-author
          </h2>
          <p id="coauthor-hint">
            {!selectedReportId
              ? 'Choose the research above, then tell the co-author what the paper should be.'
              : project
                ? `Everyone in ${project.name} sees this conversation and can talk to the co-author. It reads the research, its sources and the project before every answer.`
                : 'Tell the co-author what to write or change. It reads the research and its sources before every answer.'}
          </p>
        </div>

        {selectedReportId && (
          <div className="coauthor-thread" role="log" aria-live="polite" aria-label="Conversation with the co-author">
            {!shownPaper?.messages.length && (
              <ChatBubble
                speaker="Co-author"
                body={
                  `I'll write from your research “${selectedReport?.question || topicTitle}”` +
                  (project?.work ? ` and the paper “${project.work.title}” that ${project.name} collaborates on` : '') +
                  '. What should the paper focus on? For example an angle, an audience or venue, or results of your own to include. ' +
                  "Tell me here, or select Draft paper and I'll start from the research as it is."
                }
              />
            )}
            {shownPaper?.messages.map((m) => <ChatMessage key={m.id} message={m} />)}
            {coauthorWorking && (
              <div className="coauthor-typing" role="status">
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
                {isGenerating || busy?.task === 'writing a new draft'
                  ? `Drafting the paper${busy && !isGenerating ? ` for ${busy.by}` : ''}. This takes a minute or two.`
                  : `The co-author is working${busy && !isSending ? ` on ${busy.by}'s request` : ''}…`}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        )}

        <form
          className="coauthor-input-row"
          onSubmit={(e) => {
            e.preventDefault()
            sendMessage()
          }}
        >
          <label className="visually-hidden" htmlFor="coauthor-instruction">
            Message to the co-author
          </label>
          <textarea
            id="coauthor-instruction"
            className="coauthor-text-input"
            rows={2}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder={
              !selectedReportId
                ? 'Choose the research first'
                : hasDraft
                  ? 'Ask for a change, or ask about the paper. Enter sends, Shift+Enter adds a line.'
                  : 'What should the paper focus on?'
            }
            aria-describedby="coauthor-hint"
            disabled={!selectedReportId}
          />
          <button type="submit" className="studio-btn studio-btn-primary" disabled={!selectedReportId || !chatInput.trim() || coauthorWorking}>
            {isSending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            Send
          </button>
        </form>
        {hasDraft && (
          <div className="coauthor-pills-row" role="group" aria-labelledby="quick-steering-label">
            <span className="pills-label" id="quick-steering-label">
              Quick requests
            </span>
            {QUICK_PROMPTS.map((prompt) => (
              <button type="button" key={prompt} className="coauthor-pill-btn" disabled={coauthorWorking} onClick={() => sendMessage(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className={`studio-dual-pane layout-${layout}`}>
        {layout === 'preview' ? (
          minimizedPane('editor', 'editor')
        ) : (
          <section className="studio-pane studio-code-pane" aria-labelledby="editor-title">
            <div className="pane-header">
              <div className="pane-title">
                <h2 id="editor-title">
                  <span className="visually-hidden">Editor: </span>
                  {folder && <span className="file-folder">{folder}</span>}
                  {activeFileId}
                </h2>
                <span className="file-badge-pill">{fileKind}</span>
                {hasDraft && !isImageFile && (
                  <span className="pane-meta">
                    {lineCount} lines{!editable && ' · read-only'}
                  </span>
                )}
              </div>
              <div className="pane-controls">
                {hasDraft && !isImageFile && (
                  <>
                    <button
                      type="button"
                      className={`pane-control icon ${wrap ? 'on' : ''}`}
                      aria-pressed={wrap}
                      onClick={() => setWrap((w) => !w)}
                      aria-label="Wrap long lines"
                      title="Wrap long lines"
                    >
                      <WrapText size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="pane-control icon" onClick={handleCopyCurrentFile} aria-label={`Copy ${activeFileId}`} title={`Copy ${activeFileId}`}>
                      <Copy size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="pane-control icon" onClick={handleDownloadCurrentFile} aria-label={`Download ${activeFileId}`} title={`Download ${activeFileId}`}>
                      <Download size={16} aria-hidden="true" />
                    </button>
                    <span className="pane-divider" aria-hidden="true" />
                  </>
                )}
                {paneButtons('editor', 'editor')}
              </div>
            </div>

            <div className="studio-editor-area">
              {!hasDraft ? (
                <div className="studio-empty">
                  {coauthorWorking && !shownPaper?.hasDraft ? (
                    <p role="status">
                      <LoaderCircle size={16} className="spin" aria-hidden="true" /> Drafting “{topicTitle}”…
                    </p>
                  ) : (
                    <p>No draft yet. {selectedReportId ? 'Select Draft paper, or tell the co-author what you want first.' : 'Choose the research above to begin.'}</p>
                  )}
                </div>
              ) : isImageFile ? (
                <div className="asset-preview-card">
                  <div className="asset-image-box">
                    <ImageIcon size={40} aria-hidden="true" />
                    <span className="asset-name">{activeFileId}</span>
                  </div>
                  <p className="asset-caption">
                    Placeholder for a figure about <strong>{topicTitle}</strong>. Add your own image with this name, then include it with:
                  </p>
                  <pre className="asset-latex-code">{`\\begin{figure}[t]
  \\centering
  \\includegraphics[width=\\linewidth]{figures/${activeFileId}}
  \\caption{...}
  \\label{fig:${activeFileId.replace(/\.[^/.]+$/, '')}}
\\end{figure}`}</pre>
                </div>
              ) : (
                <div className={`editor-with-lines ${wrap ? 'wrapped' : ''}`}>
                  {!wrap && (
                    <div className="line-numbers-gutter" ref={gutterRef} aria-hidden="true">
                      {lineNumbers.map((num) => (
                        <div key={num}>{num}</div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="studio-textarea"
                    value={activeContent}
                    onChange={(e) => handleActiveFileChange(e.target.value)}
                    onScroll={syncScroll}
                    readOnly={!editable || coauthorWorking}
                    aria-label={`${fileKind} source of ${activeFileId}${!editable ? ' (read-only, generated from main.tex)' : coauthorWorking ? ' (read-only while the co-author works)' : ''}`}
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {layout === 'editor' ? (
          minimizedPane('preview', 'preview')
        ) : (
          <section className="studio-pane studio-preview-pane" aria-labelledby="preview-title">
            <div className="pane-header">
              <div className="pane-title">
                <h2 id="preview-title">Preview</h2>
                <span className="file-badge-pill">{currentTpl.venue || currentTpl.name}</span>
              </div>
              <div className="pane-controls">{paneButtons('preview', 'preview')}</div>
            </div>

            {/* Focusable so keyboard users can scroll the preview */}
            {!hasDraft ? (
              <div className="studio-empty">
                <p>The formatted paper appears here once a draft exists.</p>
              </div>
            ) : (
            <div className="preview-scroll" tabIndex={0} aria-label="Formatted manuscript preview">
              <article className="academic-paper-sheet">
                <div className="paper-title-area">
                  <h3 className="paper-headline">{previewDoc.headline}</h3>
                  <div className="paper-authors">
                    <strong>{(shownPaper?.authors ?? []).map((a) => a.name + (a.affiliation ? ` (${a.affiliation})` : '')).join(', ')}</strong>
                  </div>
                </div>

                <div className="paper-abstract-card">
                  <h4 className="abstract-heading">Abstract</h4>
                  <p>{previewDoc.abstractText}</p>
                </div>

                <div className="paper-body-preview">
                  {previewDoc.sections.length > 0 ? (
                    previewDoc.sections.map((sec, idx) => (
                      <div key={idx} className="paper-section">
                        <h4>{`${idx + 1}. ${sec.title}`}</h4>
                        <RenderSectionBody body={sec.body} />
                      </div>
                    ))
                  ) : (
                    <p className="paper-empty">{isGenerating ? 'Drafting the paper…' : 'No sections yet. Re-draft the paper or ask the co-author.'}</p>
                  )}

                  <h4>References</h4>
                  <ol className="preview-references-list">
                    {references.map((r) => (
                      <li className="preview-ref-entry" key={r.key}>
                        {r.authors && <strong>{r.authors}</strong>}
                        {r.year ? ` (${r.year})` : ''}. {r.title}. <span className="ref-key">[{r.key}]</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </article>
            </div>
            )}
          </section>
        )}
      </div>

      {/* Install Custom Template Modal */}
      {installModalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setInstallModalOpen(false)
          }}
        >
          <div
            className="slides-modal studio-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-template-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setInstallModalOpen(false)
            }}
          >
            <div className="modal-top">
              <span className="section-label">
                <Plus size={14} aria-hidden="true" /> Install template
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setInstallModalOpen(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <h2 id="install-template-title" className="studio-modal-title">
              Add a journal or conference template
            </h2>
            <p className="slides-subtitle">
              Format papers for any niche conference, university dissertation, or publisher standard.
            </p>

            <form onSubmit={handleInstallCustom} className="studio-modal-form">
              <div>
                <label htmlFor="tpl-name">
                  Template name (required)
                </label>
                <input
                  id="tpl-name"
                  type="text"
                  required
                  ref={firstFieldRef}
                  placeholder="e.g. CVPR, AAAI, Bioinformatics"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="tpl-venue">
                  Venue or publisher
                </label>
                <input
                  id="tpl-venue"
                  type="text"
                  placeholder="e.g. IEEE, Springer"
                  value={customVenue}
                  onChange={(e) => setCustomVenue(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="tpl-class">
                  Document class
                </label>
                <input
                  id="tpl-class"
                  type="text"
                  value={customDocClass}
                  onChange={(e) => setCustomDocClass(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="tpl-preamble">
                  Preamble and packages
                </label>
                <textarea
                  id="tpl-preamble"
                  rows={4}
                  value={customPreamble}
                  onChange={(e) => setCustomPreamble(e.target.value)}
                />
              </div>

              <div className="studio-modal-actions">
                <button
                  type="button"
                  className="studio-btn"
                  onClick={() => setInstallModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button">
                  <Check size={15} aria-hidden="true" /> Save and apply
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

/** Readable text for simple inline LaTeX commands in the preview (the .tex source itself is untouched). */
function inlineLatex(text: string): string {
  return text
    .replace(/\\cite\{([^}]+)\}/g, '[$1]')
    .replace(/\\(?:textbf|textit|emph|texttt|textsc)\{([^}]+)\}/g, '$1')
}

function RenderSectionBody({ body }: { body: string }) {
  const chunks = body.split(/\n\s*\n/)

  return (
    <div>
      {chunks.map((chunk, cIdx) => {
        const trimmed = chunk.trim()
        if (!trimmed || trimmed.startsWith('%')) return null

        // Math equations
        if (
          trimmed.includes('\\begin{equation') ||
          trimmed.includes('\\[') ||
          trimmed.startsWith('$$') ||
          trimmed.includes('\\begin{align')
        ) {
          const cleanMath = trimmed
            .replace(/\\begin\{equation\*?\}/g, '')
            .replace(/\\end\{equation\*?\}/g, '')
            .replace(/\\\[/g, '')
            .replace(/\\\]/g, '')
            .replace(/\$\$/g, '')
            .trim()
          return (
            <div key={cIdx} className="math-display-block">
              {`$$${cleanMath}$$`}
            </div>
          )
        }

        // Tables
        if (trimmed.includes('\\begin{tabular}')) {
          const tableMatch = trimmed.match(/\\begin\{tabular\}\{[^}]+\}([\s\S]*?)\\end\{tabular\}/)
          if (tableMatch) {
            const rawRows = tableMatch[1]
              .split('\\\\')
              .map((r) => r.replace(/\\toprule|\\midrule|\\bottomrule|\\hline/g, '').trim())
              .filter((r) => r.length > 0)

            const rows = rawRows.map((r) =>
              r.split('&').map((cell) => cell.replace(/\\textbf\{([^}]+)\}/g, '$1').replace(/\$([^$]+)\$/g, '$1').trim())
            )

            if (rows.length > 0) {
              const headers = rows[0]
              const dataRows = rows.slice(1)
              return (
                <div key={cIdx} className="paper-table-wrap" tabIndex={0} role="region" aria-label="Table (scrolls sideways)">
                  <table className="paper-latex-table">
                    <thead>
                      <tr>
                        {headers.map((h, hIdx) => (
                          <th key={hIdx}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataRows.map((row, rIdx) => (
                        <tr key={rIdx}>
                          {row.map((cell, cellIdx) => (
                            <td key={cellIdx}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          }
        }

        // Bullet lists
        if (trimmed.includes('\\begin{itemize}') || trimmed.includes('\\begin{enumerate}')) {
          const items = trimmed
            .split('\\item')
            .slice(1)
            .map((item) =>
              item
                .replace(/\\end\{itemize\}|\\end\{enumerate\}/g, '')
                .replace(/\\cite\{([^}]+)\}/g, '[$1]')
                .replace(/\\textbf\{([^}]+)\}/g, '$1')
                .trim()
            )
            .filter((item) => item.length > 0)

          return (
            <ul key={cIdx} className="preview-evidence-list">
              {items.map((it, itIdx) => (
                <li key={itIdx}>{it}</li>
              ))}
            </ul>
          )
        }

        // Regular paragraphs
        const cleanPara = inlineLatex(trimmed)
          .replace(/\\subsection\*?\{([^}]+)\}/g, '• $1:')
          .replace(/\\subsubsection\*?\{([^}]+)\}/g, '• $1:')

        return (
          <p key={cIdx}>
            {cleanPara}
          </p>
        )
      })}
    </div>
  )
}

function ChatBubble({ speaker, body, mine = false, meta }: { speaker: string; body: string; mine?: boolean; meta?: string }) {
  return (
    <div className={`coauthor-msg${mine ? ' mine' : ''}${speaker === 'Co-author' ? ' from-coauthor' : ''}`}>
      <div className="coauthor-msg-head">
        <strong>{speaker}</strong>
        {meta && <span>{meta}</span>}
      </div>
      <p>{body}</p>
    </div>
  )
}

function ChatMessage({ message: m }: { message: PaperChatMessage }) {
  const speaker = m.role === 'coauthor' ? 'Co-author' : m.mine ? 'You' : m.author?.name || 'Former author'
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return <ChatBubble speaker={speaker} body={m.body} mine={m.mine} meta={time + (m.version ? ` · updated the paper (version ${m.version})` : '')} />
}
