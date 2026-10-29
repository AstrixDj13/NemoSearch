import { useState } from 'react'
import { ArrowUpRight, Search, Users } from 'lucide-react'
import type { Project } from '../data'

interface CollaborationHeaderProps {
  project: Project & { work: NonNullable<Project['work']> }
  onOpenWork: (workId: string) => void
  /** Starts new research in this project, focused on its paper */
  onResearch: () => void
}

// Top of a collaboration project: what paper it is about, who is in it, and how the space works
export default function CollaborationHeader({ project, onOpenWork, onResearch }: CollaborationHeaderProps) {
  const [expanded, setExpanded] = useState(false)
  const { work } = project
  const people = project.counts.members + 1

  return (
    <section className="collab-header" aria-labelledby="collab-title">
      <div className="section-label">
        <Users size={13} aria-hidden="true" /> Collaboration on a paper · {people} {people === 1 ? 'person' : 'people'}
      </div>
      <h2 id="collab-title">
        <a
          href={`/network/works/${work.id}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return
            event.preventDefault()
            onOpenWork(work.id)
          }}
        >
          {work.title} <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </h2>
      {work.authors.length > 0 && <p className="collab-authors">{work.authors.join(', ')}</p>}
      {work.abstract && (
        <p className={`collab-abstract ${expanded ? 'expanded' : ''}`}>
          {work.abstract}{' '}
        </p>
      )}
      {work.abstract.length > 280 && (
        <button type="button" className="text-link" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Show less' : 'Show full abstract'}
        </button>
      )}
      <div className="collab-how">
        <p>
          Everything here is shared with {project.role === 'owner' ? 'your collaborators' : `${project.owner?.name ?? 'the owner'} and the other collaborators`}: research
          runs, notes, saved sources and files. Research you start with this project selected knows about this paper, so
          you can ask things like “what has been published on this since 2023?”
        </p>
        <button type="button" className="primary-button" onClick={onResearch}>
          <Search size={16} aria-hidden="true" /> Research this paper
        </button>
      </div>
    </section>
  )
}
