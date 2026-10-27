export type FocusMode = 'web' | 'academic' | 'finance' | 'news'
export type View = 'home' | 'running' | 'report' | 'library' | 'activity' | 'studio'

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
  bib_key?: string
  bibtex?: string
  doi?: string
  venue?: string
  citations?: number
  year?: number | string
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

export interface SavedReport {
  id: string
  title: string
  mode: string
  time: string
  sources: number
  reportText?: string
  sourcesData?: Source[]
  reasoningTrace?: string
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
