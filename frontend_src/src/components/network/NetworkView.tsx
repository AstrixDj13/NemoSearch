import { Plus } from 'lucide-react'
import DiscoverPage from './DiscoverPage'
import MyWorksPage from './MyWorksPage'
import RequestsPage from './RequestsPage'
import WorkPage from './WorkPage'
import OrgPage from './OrgPage'
import AdminPage from './AdminPage'
import { PersonPage, ProfilePage } from './PeoplePages'
import type { NetworkContext } from './shared'
import type { NetworkRoute } from '../../network'

const TABS: { page: 'discover' | 'mine' | 'requests' | 'profile' | 'admin'; label: string }[] = [
  { page: 'discover', label: 'Discover' },
  { page: 'mine', label: 'My works' },
  { page: 'requests', label: 'Requests' },
  { page: 'profile', label: 'Profile' },
  { page: 'admin', label: 'Admin' },
]

// The public-facing side of NemoSearch. Library stays private; nothing reaches here unless its owner publishes it.
export default function NetworkView({ ctx, route, onPublish }: { ctx: NetworkContext; route: NetworkRoute; onPublish: () => void }) {
  const { me } = ctx
  const tabs = TABS.filter((t) => (t.page === 'admin' ? me?.isAdmin : t.page === 'discover' || me))
  const activeTab = tabs.some((t) => t.page === route.page) ? route.page : null

  return (
    <section className="library-view network-view">
      <div className="page-heading">
        <div>
          <div className="section-label">Public research network</div>
          <h1>Network</h1>
        </div>
        {me && (
          <div className="page-heading-actions">
            <button type="button" className="primary-button" onClick={onPublish}>
              <Plus size={16} aria-hidden="true" /> Publish
            </button>
          </div>
        )}
      </div>
      <nav className="net-tabs" aria-label="Network sections">
        {tabs.map((t) => (
          <a
            key={t.page}
            href={t.page === 'discover' ? '/network' : `/network/${t.page}`}
            aria-current={activeTab === t.page ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault()
              ctx.navigate({ page: t.page })
            }}
          >
            {t.label}
            {t.page === 'requests' && me && me.pendingRequests + me.unreadNotifications > 0 && (
              <span className="net-count-badge" aria-label={`${me.pendingRequests + me.unreadNotifications} new`}>
                {me.pendingRequests + me.unreadNotifications}
              </span>
            )}
          </a>
        ))}
      </nav>
      <div className="network-body">
        {route.page === 'discover' && <DiscoverPage ctx={ctx} />}
        {route.page === 'mine' && me && <MyWorksPage ctx={ctx} />}
        {route.page === 'requests' && me && <RequestsPage ctx={ctx} />}
        {route.page === 'profile' && me && <ProfilePage ctx={ctx} me={me} />}
        {route.page === 'admin' && me?.isAdmin && <AdminPage ctx={ctx} />}
        {route.page === 'work' && <WorkPage key={route.id} ctx={ctx} id={route.id} />}
        {route.page === 'person' && <PersonPage key={route.id} ctx={ctx} id={route.id} />}
        {route.page === 'org' && <OrgPage key={route.id} ctx={ctx} id={route.id} />}
      </div>
    </section>
  )
}
