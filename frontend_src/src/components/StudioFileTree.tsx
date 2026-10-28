import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Code, FileCode, FileText, FolderOpen, Image as ImageIcon } from 'lucide-react'

const FOLDERS = [
  { name: 'sections', files: ['01_introduction.tex', '02_related_work.tex', '03_methodology.tex', '04_experiments.tex'] },
  { name: 'figures', files: ['system_pipeline.png', 'tradeoff_benchmarks.png'] },
  { name: 'styles', files: ['neurips_2024.sty'] },
]
const ROOT_FILES = ['main.tex', 'references.bib', 'README.md']

function FileIcon({ name }: { name: string }) {
  const props = { size: 15, 'aria-hidden': true } as const
  if (name.endsWith('.png')) return <ImageIcon {...props} className="tree-icon-image" />
  if (name.endsWith('.bib')) return <BookOpen {...props} className="tree-icon-bib" />
  if (name.endsWith('.sty')) return <Code {...props} className="tree-icon-sty" />
  if (name.endsWith('.md')) return <FileText {...props} className="tree-icon-md" />
  return <FileCode {...props} className="tree-icon-tex" />
}

interface Props {
  activeFile: string
  onSelect: (file: string) => void
  /** Sidebar is in its narrow icon rail: show one button that expands it instead of an unreadable tree */
  collapsed: boolean
  onExpand: () => void
}

/** The Paper Studio project's files, shown in the app sidebar. */
export default function StudioFileTree({ activeFile, onSelect, collapsed, onExpand }: Props) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({ sections: true, figures: true, styles: true })
  // The rail button disappears when the sidebar expands, so keyboard focus moves on to the file filter
  const focusFilter = useRef(false)
  const filterRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!collapsed && focusFilter.current) {
      focusFilter.current = false
      filterRef.current?.focus()
    }
  }, [collapsed])

  if (collapsed) {
    return (
      <div className="studio-files-rail">
        <button type="button" className="studio-files-rail-button" onClick={() => { focusFilter.current = true; onExpand() }} aria-label={`Project files (open file: ${activeFile}). Expand sidebar`} title="Project files">
          <FolderOpen size={18} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const q = filter.trim().toLowerCase()
  const matches = (f: string) => !q || f.toLowerCase().includes(q)
  const folders = FOLDERS.map((d) => ({ ...d, shown: d.files.filter(matches) })).filter((d) => !q || d.shown.length)
  const rootShown = ROOT_FILES.filter(matches)
  const fileButton = (file: string) => (
    <li key={file}>
      <button
        type="button"
        className={`studio-tree-row file ${activeFile === file ? 'active' : ''}`}
        aria-current={activeFile === file ? 'true' : undefined}
        title={file}
        onClick={() => onSelect(file)}
      >
        <FileIcon name={file} />
        <span>{file}</span>
      </button>
    </li>
  )

  return (
    <nav className="studio-files" aria-labelledby="studio-files-title">
      <div className="section-label" id="studio-files-title">
        Project files
      </div>
      <label className="visually-hidden" htmlFor="studio-file-filter">
        Filter files
      </label>
      <input
        id="studio-file-filter"
        ref={filterRef}
        className="studio-files-filter"
        type="search"
        placeholder="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul className="studio-tree">
        {folders.map((d) => {
          // A filter always shows matching files, even inside a folder the user closed
          const expanded = Boolean(q) || open[d.name]
          return (
            <li key={d.name}>
              <button
                type="button"
                className="studio-tree-row folder"
                aria-expanded={expanded}
                aria-controls={`studio-folder-${d.name}`}
                onClick={() => setOpen((prev) => ({ ...prev, [d.name]: !prev[d.name] }))}
              >
                {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                <FolderOpen size={15} aria-hidden="true" className="tree-icon-folder" />
                <span>{d.name}/</span>
                <span className="studio-tree-count">
                  {d.files.length}
                  <span className="visually-hidden"> files</span>
                </span>
              </button>
              {expanded && (
                <ul className="studio-tree nested" id={`studio-folder-${d.name}`}>
                  {(q ? d.shown : d.files).map(fileButton)}
                </ul>
              )}
            </li>
          )
        })}
        {rootShown.map(fileButton)}
      </ul>
      {q && !folders.length && !rootShown.length && (
        <p className="studio-files-empty" role="status">
          No files match “{filter.trim()}”.
        </p>
      )}
    </nav>
  )
}
