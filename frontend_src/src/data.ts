export type FocusMode = 'web' | 'academic' | 'finance' | 'news'
export type View = 'home' | 'running' | 'report' | 'library' | 'activity'

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
}

export interface SlideItem {
  num: number | string
  title: string
  bullets: string[]
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
  },
  {
    id: 2,
    title: 'Mixtral of Experts',
    authors: 'Jiang et al.',
    domain: 'arxiv.org',
    url: 'https://arxiv.org/abs/2401.04088',
    relevance: 94,
    quote: 'For every token, at each layer, a router network selects two experts to process the current state and combine their outputs.',
  },
  {
    id: 3,
    title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
    authors: 'Dao et al.',
    domain: 'arxiv.org',
    url: 'https://arxiv.org/abs/2205.14135',
    relevance: 89,
    quote: 'We argue that a missing principle is making attention algorithms IO-aware -- accounting for reads and writes between levels of GPU memory.',
  },
]

export const sources = sampleSources

export const defaultResearchSteps = [
  { name: 'Planner', model: 'Nemotron 3 Nano · 30B', detail: 'Decomposed the question into 4 research paths' },
  { name: 'Scout', model: 'Tavily AI Search', detail: 'Retrieved and ranked 12 primary sources' },
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
