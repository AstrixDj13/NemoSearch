export default function Logo({ compact = false }: { compact?: boolean }) {
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
