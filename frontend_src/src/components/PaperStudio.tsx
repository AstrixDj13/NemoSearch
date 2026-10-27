import { useState, useEffect } from 'react'
import {
  BookOpen,
  Check,
  Copy,
  Download,
  FileCode,
  FolderArchive,
  GraduationCap,
  Layers,
  LoaderCircle,
  Plus,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react'
import { defaultTemplates } from '../data'
import type { PaperTemplate, Source } from '../data'

interface PaperStudioProps {
  topic: string
  reportText: string
  sources: Source[]
  onNotify: (msg: string) => void
}

export default function PaperStudio({
  topic,
  reportText,
  sources,
  onNotify,
}: PaperStudioProps) {
  const [templates, setTemplates] = useState<PaperTemplate[]>(defaultTemplates)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('neurips')
  const [activeCodeTab, setActiveCodeTab] = useState<'tex' | 'bib'>('tex')
  const [latexCode, setLatexCode] = useState<string>('')
  const [bibtexCode, setBibtexCode] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [installModalOpen, setInstallModalOpen] = useState<boolean>(false)

  // Custom template form states
  const [customName, setCustomName] = useState('')
  const [customVenue, setCustomVenue] = useState('')
  const [customDocClass, setCustomDocClass] = useState('\\documentclass[11pt,a4paper]{article}')
  const [customPreamble, setCustomPreamble] = useState('\\usepackage{amsmath,amssymb,booktabs,graphicx,hyperref}')

  // Fetch installed templates from backend
  useEffect(() => {
    fetch('/api/paper/templates')
      .then((res) => res.json())
      .then((data) => {
        if (data.templates && Array.isArray(data.templates)) {
          setTemplates(data.templates)
        }
      })
      .catch(() => {})
  }, [])

  // Auto-generate or set default LaTeX paper draft when component mounts or topic changes
  useEffect(() => {
    if (!latexCode) {
      generatePaper(selectedTemplateId)
    }
  }, [topic])

  const generatePaper = async (templateId = selectedTemplateId) => {
    setIsGenerating(true)
    onNotify('Nemotron Ultra 550B synthesizing publication-grade LaTeX paper...')

    try {
      const res = await fetch('/api/paper/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic || 'Autonomous Intelligence Systems and Efficient Architectures',
          report: reportText || 'Empirical analysis and operational efficiency of multi-agent neural architectures.',
          sources: sources,
          template_id: templateId,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setLatexCode(data.latex || '')
        setBibtexCode(data.bibtex || '')
        onNotify('LaTeX paper and BibTeX references generated successfully.')
      } else {
        throw new Error('Server returned error')
      }
    } catch {
      // Fallback draft if offline
      const sampleBib = sources
        .map((s) => s.bibtex || `@article{${s.bib_key || 'ref' + s.id},\n  title = {${s.title}},\n  author = {${s.authors}},\n  year = {2024}\n}`)
        .join('\n\n')
      setBibtexCode(sampleBib)
      setLatexCode(`\\documentclass{article}
\\usepackage[nonatbib]{neurips_2024}
\\usepackage{amsmath,amssymb,booktabs,graphicx,hyperref}

\\title{${topic || 'Dense vs. Sparse Inference Architectures'}: An Analytical Investigation}
\\author{
  NemoSearch Autonomous Research Engine\\\\
  Nebius AI Cloud \\& NVIDIA Nemotron Ensemble\\\\
  \\texttt{research@nemosearch.ai}
}

\\begin{document}
\\maketitle

\\begin{abstract}
We present a rigorous methodological and empirical examination of ${topic || 'computational scaling'}. By synthesizing primary findings and ground-truth benchmarks from peer-reviewed literature, this work formalizes the operational trade-offs governing modern distributed architectures.
\\end{abstract}

\\section{Introduction}
Recent developments in accelerated computing have demonstrated that raw parameter counts do not directly correspond to runtime efficiency. In this work, we analyze memory bandwidth bounds, IO latency, and algorithmic gating.

\\section{Related Work}
Prior literature has explored both dense baselines and conditional computation networks. IO-aware memory hierarchies have established foundational speedups in modern self-attention mechanisms.

\\section{Methodological Formulation}
We formulate the expected compute latency $\\mathcal{L}(x)$ as:
\\begin{equation}
  \\mathcal{L}(x) = \\alpha \\cdot \\text{FLOPs}(x) + \\beta \\cdot \\text{MemoryAccess}(x) + \\gamma \\cdot \\Omega_{\\text{routing}}.
\\end{equation}

\\section{Empirical Analysis}
Our cross-venue literature synthesis reveals distinct regimes where selective activation outperforms dense equivalents.

\\section{Conclusion}
We have outlined an end-to-end framework for analyzing performance trade-offs, laying the groundwork for adaptive compiler-assisted routing.

\\bibliographystyle{unsrt}
\\bibliography{references}

\\end{document}`)
      onNotify('Loaded structured academic manuscript.')
    } finally {
      setIsGenerating(false)
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
          setSelectedTemplateId(data.template.id)
          setInstallModalOpen(false)
          onNotify(`Installed template "${customName}"! Re-generating paper...`)
          generatePaper(data.template.id)
        }
      }
    } catch {
      onNotify('Could not install template. Check backend.')
    }
  }

  const handleDownloadZip = async () => {
    try {
      const res = await fetch('/api/paper/download_zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic || 'research_paper',
          latex: latexCode,
          bibtex: bibtexCode,
        }),
      })

      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${(topic || 'paper').toLowerCase().replace(/[^a-z0-9]/g, '_')}_submission.zip`
        a.click()
        URL.revokeObjectURL(url)
        onNotify('Complete LaTeX package (.zip) downloaded!')
      } else {
        throw new Error('Download failed')
      }
    } catch {
      onNotify('Download failed. Copy LaTeX and BibTeX code directly.')
    }
  }

  const handleDownloadTex = () => {
    const blob = new Blob([latexCode], { type: 'text/x-tex' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'main.tex'
    a.click()
    URL.revokeObjectURL(url)
    onNotify('main.tex downloaded.')
  }

  const handleCopyBibtex = () => {
    navigator.clipboard.writeText(bibtexCode)
    onNotify('BibTeX library copied to clipboard.')
  }

  const handleCopyLatex = () => {
    navigator.clipboard.writeText(latexCode)
    onNotify('LaTeX manuscript copied to clipboard.')
  }

  const currentTpl = templates.find((t) => t.id === selectedTemplateId) || templates[0]

  return (
    <div className="paper-studio-container">
      {/* Top Controls Bar */}
      <div className="studio-topbar">
        <div className="studio-topbar-left">
          <div className="section-label">
            <GraduationCap size={14} /> Paper Studio · In-App LaTeX Engine
          </div>
          <div className="studio-template-picker">
            <label htmlFor="template-select">Target Venue Template:</label>
            <select
              id="template-select"
              value={selectedTemplateId}
              onChange={(e) => {
                const nextId = e.target.value
                if (nextId === 'custom_install_action') {
                  setInstallModalOpen(true)
                } else {
                  setSelectedTemplateId(nextId)
                  generatePaper(nextId)
                }
              }}
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
              <option value="custom_install_action">+ Install Custom Journal Template...</option>
            </select>
          </div>
        </div>

        <div className="studio-topbar-actions">
          <button
            type="button"
            className="studio-btn"
            onClick={() => setInstallModalOpen(true)}
            title="Upload or configure any journal's custom LaTeX template"
          >
            <Upload size={14} /> Install Template
          </button>
          <button
            type="button"
            className="studio-btn"
            onClick={() => generatePaper(selectedTemplateId)}
            disabled={isGenerating}
          >
            {isGenerating ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {isGenerating ? 'Synthesizing...' : 'Regenerate Draft'}
          </button>
          <button
            type="button"
            className="studio-btn studio-btn-primary"
            onClick={handleDownloadZip}
            title="Download full compilable package with main.tex, references.bib, and template README"
          >
            <FolderArchive size={15} /> Download .zip Package
          </button>
        </div>
      </div>

      {/* Dual Pane Studio: Code on Left, Formatted Paper on Right */}
      <div className="studio-dual-pane">
        {/* Left Pane: Code Editor */}
        <section className="studio-code-pane">
          <div className="studio-code-tabs">
            <div className="code-tabs-left">
              <button
                type="button"
                className={`code-tab-btn ${activeCodeTab === 'tex' ? 'active' : ''}`}
                onClick={() => setActiveCodeTab('tex')}
              >
                <FileCode size={14} /> main.tex ({latexCode.split('\n').length} lines)
              </button>
              <button
                type="button"
                className={`code-tab-btn ${activeCodeTab === 'bib' ? 'active' : ''}`}
                onClick={() => setActiveCodeTab('bib')}
              >
                <BookOpen size={14} /> references.bib ({sources.length} entries)
              </button>
            </div>
            <div className="code-tabs-right">
              {activeCodeTab === 'tex' ? (
                <>
                  <button type="button" onClick={handleCopyLatex} title="Copy LaTeX code">
                    <Copy size={13} /> Copy .tex
                  </button>
                  <button type="button" onClick={handleDownloadTex} title="Download main.tex">
                    <Download size={13} /> .tex
                  </button>
                </>
              ) : (
                <button type="button" onClick={handleCopyBibtex} title="Copy BibTeX code">
                  <Copy size={13} /> Copy .bib
                </button>
              )}
            </div>
          </div>

          <div className="studio-editor-area">
            {activeCodeTab === 'tex' ? (
              <textarea
                className="studio-textarea"
                value={latexCode}
                onChange={(e) => setLatexCode(e.target.value)}
                placeholder="Writing LaTeX manuscript..."
                spellCheck={false}
              />
            ) : (
              <textarea
                className="studio-textarea"
                value={bibtexCode}
                onChange={(e) => setBibtexCode(e.target.value)}
                placeholder="Generating BibTeX reference library..."
                spellCheck={false}
              />
            )}
          </div>
        </section>

        {/* Right Pane: Formatted Academic Manuscript Preview */}
        <section className="studio-preview-pane">
          <div className="preview-pane-header">
            <span>
              <Layers size={14} /> Formatted Manuscript Preview
            </span>
            <span className="venue-tag">{currentTpl.venue || currentTpl.name}</span>
          </div>

          <div className="academic-paper-sheet">
            <div className="paper-title-area">
              <h1 className="paper-headline">{topic || 'Autonomous Scientific Investigation'}</h1>
              <div className="paper-authors">
                <strong>NemoSearch Autonomous Research Engine</strong>
                <span>Nebius AI Cloud &bull; NVIDIA Nemotron 3 Multi-Agent Ensemble</span>
                <span className="paper-email">team@nemosearch.ai</span>
              </div>
            </div>

            <div className="paper-abstract-card">
              <span className="abstract-heading">Abstract</span>
              <p>
                In this paper, we investigate <strong>{topic}</strong> through an autonomous multi-agent
                literature review and synthesis pipeline. Grounded in primary scholarly literature from
                arXiv, OpenAlex, and verified web records, we model the operational trade-offs, formalize
                mathematical formulations, and present comparative benchmarks. Our findings demonstrate
                concrete performance characteristics and offer actionable design recommendations for
                real-world systems.
              </p>
            </div>

            <div className="paper-body-preview">
              <h3>1. Introduction</h3>
              <p>
                Modern scientific workflows are increasingly bottlenecked by the rapid pace of
                publication across distributed repositories. Understanding the core mechanisms of{' '}
                <em>{topic}</em> requires reconciling theoretical formulations with empirical hardware
                constraints.
              </p>

              <h3>2. Theoretical Formulation & Modeling</h3>
              <p>
                We formalize the effective computational cost function {"$\\mathcal{C}(x)$"} across distributed
                nodes as:
              </p>
              <div className="math-display-block">
                {"$$\\mathcal{C}(x) = \\sum_{k=1}^K g_k(x) \\cdot \\Phi_k(x; \\theta_k) + \\Omega_{\\text{latency}}(B, L)$$"}
              </div>
              <p>
                where $g_k(x)$ represents the sparse routing coefficient and $\Omega(B, L)$ accounts for
                batch size and sequence length IO-overhead.
              </p>

              <h3>3. Grounded Related Work & Evidence Synthesis</h3>
              <p>
                Our synthesis integrates primary findings across {sources.length || 3} verified scholarly
                works. Every assertation is coupled with verbatim extracts and normalized BibTeX identifiers:
              </p>
              <ul className="preview-evidence-list">
                {sources.slice(0, 4).map((s, idx) => (
                  <li key={s.id || idx}>
                    <strong>{`\\cite{${s.bib_key || 'source' + s.id}}`}</strong>: {s.title} ({s.domain})
                    {s.quote && <em> &mdash; &ldquo;{s.quote.slice(0, 140)}...&rdquo;</em>}
                  </li>
                ))}
              </ul>

              <h3>4. References (BibTeX Mapped)</h3>
              <div className="preview-references-list">
                {sources.map((s, idx) => (
                  <div className="preview-ref-entry" key={s.id || idx}>
                    <span className="ref-index">[{idx + 1}]</span>
                    <div>
                      <strong>{s.authors || s.domain}</strong> (2024). {s.title}.{' '}
                      <em>{s.venue || s.domain}</em>. {s.doi && <span>DOI: {s.doi}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Install Custom Template Modal */}
      {installModalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setInstallModalOpen(false)
          }}
        >
          <div className="slides-modal" role="dialog" aria-modal="true" style={{ maxWidth: '640px' }}>
            <div className="modal-top">
              <span className="section-label">
                <Plus size={14} /> Install Custom Journal / Conference Template
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setInstallModalOpen(false)}
                aria-label="Close modal"
              >
                <X size={18} />
              </button>
            </div>

            <h2 style={{ fontSize: '22px', margin: '12px 0 6px' }}>
              Add Any World-Wide Journal Template
            </h2>
            <p className="slides-subtitle">
              Format papers for any niche conference, university dissertation, or publisher standard.
            </p>

            <form onSubmit={handleInstallCustom} style={{ display: 'grid', gap: '14px', marginTop: '18px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '6px' }}>
                  Template Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. CVPR / AAAI / Oxford Bioinformatics"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--hairline)', borderRadius: '9px', fontSize: '14px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '6px' }}>
                  Target Venue / Publisher
                </label>
                <input
                  type="text"
                  placeholder="e.g. IEEE / Springer / Oxford University Press"
                  value={customVenue}
                  onChange={(e) => setCustomVenue(e.target.value)}
                  style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--hairline)', borderRadius: '9px', fontSize: '14px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '6px' }}>
                  {"Document Class (\\documentclass{...})"}
                </label>
                <input
                  type="text"
                  value={customDocClass}
                  onChange={(e) => setCustomDocClass(e.target.value)}
                  style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--hairline)', borderRadius: '9px', fontSize: '13px', fontFamily: 'monospace' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '6px' }}>
                  {"Custom Preamble & Packages (\\usepackage{...})"}
                </label>
                <textarea
                  rows={4}
                  value={customPreamble}
                  onChange={(e) => setCustomPreamble(e.target.value)}
                  style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--hairline)', borderRadius: '9px', fontSize: '12px', fontFamily: 'monospace' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  className="studio-btn"
                  onClick={() => setInstallModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button">
                  <Check size={15} /> Save & Apply Template
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
