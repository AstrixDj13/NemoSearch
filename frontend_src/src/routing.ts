// Research routing: which model each pipeline step uses, grouped into presets.
// Step keys match the backend's per-step model overrides.

export type TeamStep = 'planner' | 'scout' | 'reader' | 'critic' | 'writer'
export type TeamModels = Record<TeamStep, string>
export type Preset = 'fast' | 'balanced' | 'thorough'
export type Routing = { preset: Preset | 'custom'; models: TeamModels }
export type RoutingScope = 'run' | 'default'

export const teamSteps: { key: TeamStep; name: string; purpose: string }[] = [
  { key: 'planner', name: 'Planner', purpose: 'Breaks the question into search paths' },
  { key: 'scout', name: 'Scout', purpose: 'Finds and ranks sources' },
  { key: 'reader', name: 'Readers', purpose: 'Extract evidence from each source' },
  { key: 'critic', name: 'Critic', purpose: 'Checks coverage and finds gaps' },
  { key: 'writer', name: 'Lead analyst', purpose: 'Writes the cited brief' },
]

export const presetOrder: Preset[] = ['fast', 'balanced', 'thorough']

export const presetInfo: Record<Preset | 'custom', { label: string; description: string }> = {
  fast: { label: 'Fast', description: 'Lighter models for quick, everyday questions.' },
  balanced: { label: 'Balanced', description: 'Recommended. The right-sized model for each stage.' },
  thorough: { label: 'Thorough', description: 'Larger models for complex or high-stakes questions. Slower.' },
  custom: { label: 'Custom', description: 'You changed individual agents. Pick a preset to start over.' },
}

const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B'
const SUPER = 'nvidia/nemotron-3-super-120b-a12b'
const ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b'

// Used until /api/models answers; the backend sends presets built from its resolved catalog
export const fallbackPresets: Record<Preset, TeamModels> = {
  fast: { planner: NANO, scout: 'tavily', reader: NANO, critic: NANO, writer: SUPER },
  balanced: { planner: NANO, scout: 'tavily', reader: SUPER, critic: NANO, writer: ULTRA },
  thorough: { planner: SUPER, scout: 'tavily', reader: SUPER, critic: ULTRA, writer: ULTRA },
}

const modelLabels: Record<string, string> = {
  [NANO]: 'Nemotron 3 Nano · 30B',
  [SUPER]: 'Nemotron 3 Super · 120B',
  [ULTRA]: 'Nemotron 3 Ultra · 550B',
  tavily: 'Tavily AI Search',
  wikipedia: 'Wikipedia Search',
}

export const modelLabel = (id: string) => modelLabels[id] || id.split('/').pop() || id

export const routingModels = (routing: Routing, presets: Record<Preset, TeamModels>): TeamModels =>
  routing.preset === 'custom' ? routing.models : presets[routing.preset]

export const defaultRouting = (presets: Record<Preset, TeamModels> = fallbackPresets): Routing => ({
  preset: 'balanced',
  models: presets.balanced,
})

const ROUTING_KEY = 'nemosearch_routing'

export const loadRouting = (): Routing => {
  try {
    const stored = JSON.parse(localStorage.getItem(ROUTING_KEY) || 'null')
    if (stored && [...presetOrder, 'custom'].includes(stored.preset)) {
      return { preset: stored.preset, models: { ...fallbackPresets.balanced, ...stored.models } }
    }
  } catch {
    // Fall back to the recommended routing
  }
  return defaultRouting()
}

/** Persists the default routing; returns false when the browser refuses storage. */
export const storeRouting = (routing: Routing): boolean => {
  try {
    localStorage.setItem(ROUTING_KEY, JSON.stringify(routing))
    return true
  } catch {
    return false
  }
}

/** A model is unavailable when the loaded catalog does not offer it. Unknown until the catalog loads. */
export const isAvailable = (step: TeamStep, model: string, modelOptions: string[], providerOptions: string[]) => {
  const options = step === 'scout' ? providerOptions : modelOptions
  return options.length === 0 || options.includes(model)
}
