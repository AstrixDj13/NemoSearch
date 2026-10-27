// Display helpers for retrieved sources (web pages and scholarly papers)
import type { Source } from './data'

export const isPaper = (source: Source) => source.kind === 'paper' && Boolean(source.paper)

export const formatAuthors = (authors: string[]) =>
  authors.length === 0 ? 'Authors not listed' : authors.length > 3 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', ')

export const formatRetrieved = (iso?: string) => {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
}

/** Citation hover / evidence-stream subtitle: "Venue, 2021" for papers, the domain for pages */
export const sourceOrigin = (source: Source) =>
  isPaper(source) ? [source.paper!.venue, source.paper!.year].filter(Boolean).join(', ') || 'Scholarly paper' : source.domain
