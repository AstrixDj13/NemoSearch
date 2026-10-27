import { AlertTriangle, BookOpen, Globe2 } from 'lucide-react'
import type { RunCoverage, Source } from '../data'
import { formatAuthors, formatRetrieved, isPaper } from '../sources'

const STATUS_LABEL: Record<string, string> = {
  published: 'Published',
  preprint: 'Preprint',
  accepted: 'Accepted manuscript',
  retracted: 'Retracted',
  unknown: 'Publication status unknown',
}

/** One short line naming the kind of source and where it came from; text, not color, carries the distinction. */
export function SourceKind({ source }: { source: Source }) {
  if (isPaper(source)) {
    const p = source.paper!
    return (
      <span className="source-kind paper">
        <BookOpen size={13} aria-hidden="true" /> Scholarly paper · {p.connector_label}
      </span>
    )
  }
  return (
    <span className="source-kind web">
      <Globe2 size={13} aria-hidden="true" /> Web page · {source.domain}
    </span>
  )
}

/** Bibliographic details and provenance for a paper; for web pages just the retrieval record. */
export function SourceProvenance({ source }: { source: Source }) {
  if (!isPaper(source)) {
    return source.retrieved_at ? (
      <p className="provenance-line">
        Retrieved {formatRetrieved(source.retrieved_at)}
        {source.provider ? ` via ${source.provider}` : ''}
        {source.query ? ` for “${source.query}”` : ''}
      </p>
    ) : null
  }
  const p = source.paper!
  const shortId = p.source_id.replace(/^https?:\/\/openalex\.org\//, '')
  return (
    <div className="paper-meta">
      <p className="paper-authors">{formatAuthors(p.authors)}</p>
      <p className="paper-pub">
        {[p.year, p.venue || 'Venue not listed', STATUS_LABEL[p.status] ?? p.status, p.work_type].filter(Boolean).join(' · ')}
      </p>
      {p.status === 'retracted' && (
        <p className="paper-flag">
          <AlertTriangle size={13} aria-hidden="true" /> {p.connector_label} lists this work as retracted.
        </p>
      )}
      <p className="paper-access">
        {source.access === 'abstract'
          ? 'Abstract only: the full text was not retrieved or read.'
          : 'Metadata only: no abstract was available, so this paper was not used as evidence.'}
        {p.is_open_access && p.oa_url && (
          <>
            {' '}
            <a href={p.oa_url} target="_blank" rel="noreferrer">
              Open-access copy
            </a>
          </>
        )}
      </p>
      <p className="provenance-line">
        {p.doi && (
          <>
            DOI{' '}
            <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
              {p.doi}
            </a>
            {' · '}
          </>
        )}
        <a href={p.source_id} target="_blank" rel="noreferrer" aria-label={`${p.connector_label} record ${shortId}`}>
          {p.connector_label} {shortId}
        </a>
        {' · '}retrieved {formatRetrieved(source.retrieved_at)}
        {source.query ? ` for “${source.query}”` : ''}
      </p>
    </div>
  )
}

/** Shown on the report when part of the run's search coverage is missing. Never shown as success. */
export function CoverageNotice({ coverage }: { coverage?: RunCoverage | null }) {
  if (!coverage || coverage.complete) return null
  const messages = [...coverage.warnings]
  if (coverage.unverified_citations.length) {
    messages.push(
      `The brief cites ${coverage.unverified_citations.map((n) => `[${n}]`).join(', ')}, which match no retrieved source; they are marked as unverified.`
    )
  }
  return (
    <div className="coverage-notice" role="note" aria-label="Incomplete coverage">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        <strong>Partial coverage</strong>
        {messages.map((m) => (
          <p key={m}>{m}</p>
        ))}
      </div>
    </div>
  )
}

const QUERY_STATUS: Record<string, string> = { ok: 'answered', cached: 'answered from cache', failed: 'failed', pending: 'pending' }

/** The exact queries this run sent, per source, so readers can judge its coverage. */
export function CoverageLog({ coverage }: { coverage?: RunCoverage | null }) {
  if (!coverage) return null
  const scholarlyLabel = coverage.academic
    ? `Scholarly search: ${coverage.reason}.`
    : 'Scholarly search: not used; the question did not read as academic.'
  return (
    <details className="coverage-log">
      <summary>
        Search coverage · {coverage.web.length + coverage.scholarly.length} queries sent
        {coverage.scholarly_status === 'partial' || coverage.scholarly_status === 'failed' ? ' · scholarly coverage incomplete' : ''}
      </summary>
      <p>{scholarlyLabel}</p>
      {coverage.scholarly.length > 0 && (
        <table>
          <caption>Scholarly queries</caption>
          <thead>
            <tr>
              <th scope="col">Query sent</th>
              <th scope="col">Result</th>
              <th scope="col">Sent</th>
            </tr>
          </thead>
          <tbody>
            {coverage.scholarly.map((q, i) => (
              <tr key={`${q.query}-${i}`}>
                <td>
                  {q.connector === 'openalex' ? 'OpenAlex' : q.connector}: “{q.query}”
                </td>
                <td>
                  {q.status === 'failed'
                    ? `Failed after ${q.attempts} attempt${q.attempts === 1 ? '' : 's'}: ${q.error}`
                    : `${q.results} works, ${QUERY_STATUS[q.status]}${q.cached_from ? ` (retrieved ${formatRetrieved(q.cached_from)})` : ''}`}
                </td>
                <td>{formatRetrieved(q.sent_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {coverage.web.length > 0 && (
        <table>
          <caption>Web queries</caption>
          <thead>
            <tr>
              <th scope="col">Query sent</th>
              <th scope="col">Result</th>
              <th scope="col">Sent</th>
            </tr>
          </thead>
          <tbody>
            {coverage.web.map((q, i) => (
              <tr key={`${q.query}-${i}`}>
                <td>
                  {q.provider}: “{q.query}”
                </td>
                <td>{q.results} pages</td>
                <td>{formatRetrieved(q.sent_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  )
}
