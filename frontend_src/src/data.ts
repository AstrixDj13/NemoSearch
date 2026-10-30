export type FocusMode = 'web' | 'academic' | 'finance' | 'news'
export type View = 'home' | 'running' | 'report' | 'library' | 'network' | 'studio'

export interface Source {
  id: number
  title: string
  authors: string
  domain: string
  url: string
  relevance: number
  quote: string
  summary?: string
  snippet?: string
  /** 'paper' for scholarly metadata records, 'web' for pages; absent on older saved reports */
  kind?: 'paper' | 'web'
  /** What was actually read: a web page's text, a paper's open-access full text, its abstract, or metadata only */
  access?: 'page' | 'fulltext' | 'abstract' | 'metadata'
  /** For papers: whether the full text was read, and if not, why */
  fulltext?: FullTextRecord
  provider?: string
  /** The exact query that returned this source */
  query?: string
  /** ISO time the provider answered */
  retrieved_at?: string
  paper?: PaperMeta
  // Paper Studio citation data
  bib_key?: string
  bibtex?: string
  doi?: string
  venue?: string
  citations?: number
  year?: number | string
}

export interface FullTextRecord {
  status: 'ok' | 'failed' | 'skipped' | 'unavailable'
  url?: string
  retrieved_at?: string
  pages?: number
  chars?: number
  /** Only the first part of a long paper was given to the reader */
  truncated?: boolean
  error?: string
}

export interface PaperMeta {
  connector: string
  connector_label: string
  /** The provider's own identifier, e.g. https://openalex.org/W… or https://arxiv.org/abs/…v2 */
  source_id: string
  authors: string[]
  year: number | null
  venue: string
  doi: string
  work_type: string
  status: 'published' | 'preprint' | 'accepted' | 'retracted' | 'unknown'
  is_open_access: boolean
  oa_url: string
  pdf_url?: string
}

export interface ConnectorQuery {
  connector: string
  query: string
  sent_at: string
  status: 'pending' | 'ok' | 'cached' | 'failed'
  results: number
  attempts: number
  error: string
  cached_from: string
  round: number
}

export interface RunCoverage {
  academic: boolean
  reason: string
  web: { provider: string; query: string; sent_at: string; results: number; round: number }[]
  scholarly: ConnectorQuery[]
  scholarly_status: 'complete' | 'partial' | 'failed' | 'skipped'
  warnings: string[]
  unverified_citations: number[]
  complete: boolean
}

export interface SlideItem {
  num: number | string
  title: string
  bullets: string[]
}

export interface PaperTemplate {
  id: string
  name: string
  venue: string
  custom?: boolean
}

/** Paper Studio's paper for one piece of research; shared with everyone in the research's project */
export interface PaperSummary {
  id: string
  reportId: string | null
  projectId: string | null
  title: string
  question: string
  templateId: string
  /** Bumped on every change to the LaTeX or BibTeX; edits name the version they started from */
  version: number
  hasDraft: boolean
  /** Set while the co-author is drafting or answering someone */
  busy: { by: string; byId: string; task: string; since: number } | null
  updatedAt: number
}

export interface PaperChatMessage {
  id: string
  role: 'author' | 'coauthor'
  body: string
  /** The paper version this co-author message produced, when it changed the paper */
  version: number | null
  createdAt: number
  mine: boolean
  /** Null for the co-author; a null id means the author's account was deleted */
  author: { id: string | null; name: string | null } | null
}

export interface PaperDoc extends PaperSummary {
  latex: string
  bibtex: string
  authors: { id: string; name: string; affiliation: string }[]
  messages: PaperChatMessage[]
}

export interface SavedReport {
  id: string
  /** Short display title; editable */
  title: string
  /** The research question as the user asked it */
  question?: string
  /** Epoch ms; older saved reports only have the static `time` label */
  createdAt?: number
  archived?: boolean
  /** False for research outside a project that hasn't been saved: it shows in Recent research but not the Library */
  saved?: boolean
  /** Owning project; null or absent means Unassigned */
  projectId?: string | null
  /** False for placeholder entries that have no stored report body */
  hasReport?: boolean
  /** False when a collaborator ran this research in a shared project */
  mine?: boolean
  ownerName?: string
  mode: string
  time: string
  sources: number
  reportText?: string
  sourcesData?: Source[]
  reasoningTrace?: string
  /** What the run searched and whether any coverage is missing */
  coverage?: RunCoverage
  /** Follow-up questions asked about this report, oldest first */
  followups?: FollowUpRecord[]
  latexCode?: string
  bibtexCode?: string
  templateId?: string
  stats?: {
    elapsed?: number
    ttft?: number
    tokens?: number
    gaps?: string[]
  }
}

export const SAMPLE_QUERY = 'Dense vs. mixture-of-experts models for efficient inference'

export const sampleSources: Source[] = [
  {
    id: 1,
    title: 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity',
    authors: 'Fedus, Zoph & Shazeer',
    domain: 'arxiv.org',
    url: 'https://arxiv.org/abs/2101.03961',
    relevance: 96,
    quote: 'Mixture of Experts (MoE) defies this and instead selects different parameters for each incoming example.',
    bib_key: 'fedus2021switch',
    venue: 'arXiv:2101.03961',
    year: 2021,
    bibtex: `@article{fedus2021switch,
  title     = {Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity},
  author    = {Fedus, William and Zoph, Barret and Shazeer, Noam},
  year      = {2021},
  journal   = {arXiv:2101.03961},
  url       = {https://arxiv.org/abs/2101.03961}
}`,
  },
  {
    id: 2,
    title: 'Mixtral of Experts',
    authors: 'Jiang et al.',
    domain: 'arxiv.org',
    url: 'https://arxiv.org/abs/2401.04088',
    relevance: 94,
    quote: 'For every token, at each layer, a router network selects two experts to process the current state and combine their outputs.',
    bib_key: 'jiang2024mixtral',
    venue: 'arXiv:2401.04088',
    year: 2024,
    bibtex: `@article{jiang2024mixtral,
  title     = {Mixtral of Experts},
  author    = {Jiang, Albert Q. and Sablayrolles, Alexandre and Roux, Antoine and et al.},
  year      = {2024},
  journal   = {arXiv:2401.04088},
  url       = {https://arxiv.org/abs/2401.04088}
}`,
  },
  {
    id: 3,
    title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
    authors: 'Dao et al.',
    domain: 'arxiv.org',
    url: 'https://arxiv.org/abs/2205.14135',
    relevance: 89,
    quote: 'We argue that a missing principle is making attention algorithms IO-aware -- accounting for reads and writes between levels of GPU memory.',
    bib_key: 'dao2022flashattention',
    venue: 'NeurIPS 2022',
    year: 2022,
    bibtex: `@article{dao2022flashattention,
  title     = {FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness},
  author    = {Dao, Tri and Fu, Daniel Y. and Ermon, Stefano and Rudra, Atri and R{\\'e}, Christopher},
  year      = {2022},
  journal   = {Advances in Neural Information Processing Systems},
  url       = {https://arxiv.org/abs/2205.14135}
}`,
  },
]

export const sources = sampleSources

export const defaultTemplates: PaperTemplate[] = [
  { id: 'neurips', name: 'NeurIPS (Neural Information Processing Systems)', venue: 'NeurIPS 2024' },
  { id: 'icml', name: 'ICML (International Conference on Machine Learning)', venue: 'ICML 2024' },
  { id: 'iclr', name: 'ICLR (International Conference on Learning Representations)', venue: 'ICLR 2024' },
  { id: 'ieee', name: 'IEEE Transactions / Conference', venue: 'IEEE PAMI / Access' },
  { id: 'acm', name: 'ACM SIGCONF', venue: 'ACM SIGKDD / SIGIR' },
  { id: 'nature', name: 'Nature / Springer Nature', venue: 'Nature Machine Intelligence' },
  { id: 'elsevier', name: 'Elsevier Journal', venue: 'Artificial Intelligence' },
  { id: 'article', name: 'Clean Preprint Article', venue: 'Preprint / arXiv' },
]

export const defaultResearchSteps = [
  { name: 'Planner', model: 'Nemotron 3 Nano · 30B', detail: 'Decomposed the question into 4 research paths' },
  { name: 'Scout', model: 'Tavily + OpenAlex + arXiv', detail: 'Retrieved and ranked 12 primary sources' },
  { name: 'Readers', model: 'Nemotron 3 Super · 120B', detail: 'Extracted evidence in 4 parallel threads' },
  { name: 'Critic', model: 'Nemotron 3 Nano · 30B', detail: 'Resolved 2 coverage gaps and checked citations' },
  { name: 'Lead analyst', model: 'Nemotron 3 Ultra · 550B', detail: 'Synthesized the final cited briefing' },
]

export const researchSteps = defaultResearchSteps

export const recentReports: SavedReport[] = [
  { id: 'sample-1', title: SAMPLE_QUERY, mode: 'Academic', time: '12 min ago', sources: 12, sourcesData: sampleSources },
  { id: 'sample-2', title: 'The infrastructure behind real-time multimodal agents', mode: 'All web', time: 'Yesterday', sources: 18 },
  { id: 'sample-3', title: 'How inference economics are changing AI product design', mode: 'Finance', time: 'Oct 22', sources: 9 },
]

export interface Project {
  id: string
  name: string
  description: string
  notes: string
  archived: boolean
  createdAt: number
  updatedAt: number
  /** 'member' when someone else shared the project with you */
  role: 'owner' | 'member'
  owner: { id: string; name: string; orcid: string | null } | null
  /** For a collaboration project: the Network paper it was opened for (absent if you can't see that paper) */
  work?: { id: string; title: string; authors: string[]; abstract: string; tags: string[]; doi: string | null } | null
  counts: { reports: number; sources: number; attachments: number; exports: number; members: number }
}

export interface ProjectMessage {
  id: string
  body: string
  createdAt: number
  mine: boolean
  /** Null when the author's account was deleted */
  author: { id: string; name: string } | null
}

export interface ProjectMember {
  id: string
  name: string
  orcid: string | null
  affiliation: string
  addedAt: number
}

export interface SavedSourceRecord {
  id: string
  projectId: string | null
  reportId: string | null
  url: string
  title: string
  source: Source
  createdAt: number
  /** False for sources a collaborator saved to a shared project */
  mine?: boolean
}

export interface AttachmentRecord {
  id: string
  filename: string
  contentType: string
  size: number
  createdAt: number
  ownerId?: string
}

export interface ExportRecord {
  id: string
  reportId: string | null
  kind: string
  filename: string
  downloadable: boolean
  createdAt: number
}

export interface ProjectDetail extends Project {
  sources: SavedSourceRecord[]
  attachments: AttachmentRecord[]
  exports: ExportRecord[]
  members: ProjectMember[]
}

/** Which research the sidebar and library show: everything, Unassigned, or one project id */
export type ResearchScope = 'all' | 'unassigned' | string

export interface FollowUpRecord {
  question: string
  answer: string
  createdAt?: number
}
