// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { app, openExternalUrl, screenSize } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  // Whether the window is wide enough (xl) for settings to sit beside the page rather than float over it.
  screenSize: { wide: true, listeners: new Set<() => void>() },
  app: {
    agents: [
      { slug: 'writer', displaySlug: 'writer', name: 'Writer', status: 'running', avatar: null },
      { slug: 'planner', displaySlug: 'planner', name: 'Planner', status: 'stopped', avatar: null },
    ],
    deleteAgent: vi.fn(),
    /** Team Brain's drive: still making its first copy, or not read yet; and whether the drive list's last poll failed. */
    mount: 'ready' as 'ready' | 'copying' | 'loading',
    pollFailed: false,
    /** The drive the page last handed the tree and the syncs to read. */
    read: { drive: undefined as string | undefined, syncs: undefined as string | undefined },
  },
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useListedAgents: () => ({ data: app.agents }),
  useDeleteAgent: () => ({ mutate: app.deleteAgent, isPending: false }),
}))
// The Team Brain agent's own drive, in Dropbox.
vi.mock('@renderer/hooks/use-mounts', () => ({
  useAgentMounts: () => ({
    data: app.mount === 'loading' ? undefined : [{ id: 'm1', volumeId: 'vol1', name: 'Team Brain', volumeName: 'Team Brain', type: 'dropbox', hostPath: null, sourceLabel: 'Dropbox › Team Brain', health: app.mount === 'copying' ? 'preparing' : 'ok' }],
    isError: app.pollFailed,
  }),
}))
// The drive as listed: a README and three sections, with the pages the tree is clicked through.
const { drive } = vi.hoisted(() => {
  const page = (id: string, name: string) => ({ id, name, kind: 'file' as const, sources: [] })
  const folder = (id: string, name: string, children: unknown[]) => ({ id, name, kind: 'folder' as const, sources: [], children })
  return {
    drive: [
      folder('customers', 'Customers', [page('customers/acme', 'Acme Corp.md'), page('customers/hooli', 'Hooli.md'), page('customers/northwind', 'Northwind.md')]),
      folder('engineering', 'Engineering', [page('engineering/architecture', 'Architecture overview.md'), page('engineering/api', 'API.md')]),
      folder('people', 'People', [page('people/handbook', 'Handbook.md')]),
      page('readme', 'README.md'),
    ],
  }
})
// Team Brain's scheduled tasks, whatever the agent named them: set-up's upkeep, renamed, and one it added and paused.
const { upkeep } = vi.hoisted(() => ({
  upkeep: {
    tasks: [] as Array<{ id: string; name: string; status: string; scheduleExpression: string; nextExecutionAt: string; lastExecutedAt: string }>,
  },
}))
const task = (id: string, name: string, status: string) => ({
  id, name, status, scheduleExpression: '0 0 * * *', nextExecutionAt: new Date(Date.now() + 3_600_000).toISOString(), lastExecutedAt: new Date(Date.now() - 7_200_000).toISOString(),
})
// One server-visible list, including promoted automations and their original source.
const { sessions } = vi.hoisted(() => ({ sessions: { chats: [] as unknown[] } }))
vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: upkeep.tasks }),
}))
// Sources are the Team Brain agent's own connections; they open on its Connections page.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useAgentConnectedAccounts: () => ({
    data: { accounts: [{ id: 'a1', toolkitSlug: 'slack', displayName: 'Acme workspace', status: 'active', provider: { displayName: 'Slack' } }] },
  }),
}))
vi.mock('@renderer/hooks/use-oauth-reconnect', () => ({ useOAuthReconnect: () => ({ reconnect: vi.fn(), pendingAccountId: null, canCancelPendingReconnect: false, cancelReconnect: vi.fn() }) }))
// Writer has the Team Brain drive; Planner does not.
const { access } = vi.hoisted(() => ({ access: { toggle: vi.fn(), setEveryAgent: vi.fn() } }))
vi.mock('@renderer/hooks/use-team-brain-access', () => ({
  useTeamBrainAccess: () => ({ everyAgent: false, canGoGlobal: true, isOn: (slug: string) => slug === 'writer', ...access }),
}))
// The latest sync the upkeep run wrote to _brain/syncs/, as parsed.
vi.mock('@renderer/hooks/use-team-brain-syncs', () => ({
  useTeamBrainSyncs: (_slug: string, volumeId: string | undefined) => {
    app.read.syncs = volumeId
    return {
      data: [
        {
          id: '_brain/syncs/2026-10-23 0300.md', at: new Date(Date.now() - 7_200_000).toISOString(), session: 's-1', sources: ['slack', 'notion'], added: 3, updated: 9,
          highlights: [{ title: 'Acme’s renewal moves to Q1', body: 'Acme asked to move it; [Acme Corp](../../Customers/Acme%20Corp.md) has the date.' }],
          changes: ['Cycle 14 closed.'],
          needsYou: { blocked: ['Reconnect Slack. #sales was not read this run.'], toDecide: [] },
        },
      ],
    }
  },
}))
vi.mock('@renderer/hooks/use-sessions', () => ({ useSessions: () => ({ data: sessions.chats }) }))
// A session row's right-click menu needs the app's session actions; here a row is only its link.
vi.mock('@renderer/components/sessions/session-context-menu', () => ({ SessionContextMenu: ({ children }: { children: unknown }) => children }))
// Read and listed, unless a case says the drive could not be read.
const { driveRead } = vi.hoisted(() => ({
  driveRead: {
    ready: true,
    error: null as string | null,
    // The record's parts there are to show, and the parts the page last asked the tree to show.
    recordParts: [
      { name: 'syncs', path: '_brain/syncs', type: 'directory' as const },
      { name: 'rules.md', path: '_brain/rules.md', type: 'file' as const },
      { name: 'INDEX.md', path: 'INDEX.md', type: 'file' as const },
    ],
    record: new Set<string>() as ReadonlySet<string>,
  },
}))
vi.mock('@renderer/hooks/use-team-brain-drive', () => ({
  useTeamBrainDrive: (_slug: string, volumeId: string | undefined, _expanded: unknown, record: ReadonlySet<string>) => {
    app.read.drive = volumeId
    driveRead.record = record
    // A drive it is not handed is not read, so it cannot fail.
    return { drive, ready: driveRead.ready, error: volumeId ? driveRead.error : null, recordParts: driveRead.recordParts }
  },
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
const { user } = vi.hoisted(() => ({ user: { isAuthMode: false, isAdmin: false } }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => user }))
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }))
// Agent Home's composer needs the app's providers; here it only needs to be there, for the Team Brain agent.
vi.mock('./team-brain-home-composer', () => ({ TeamBrainHomeComposer: ({ agent }: { agent: { slug: string } }) => <div data-testid="team-brain-composer">{agent.slug}</div> }))
// The page mounts the app's file drawer, which reads the route; this page has no session.
vi.mock('@renderer/router/use-route-location', () => ({ useRouteLocation: () => ({ view: { kind: 'none' } }) }))
// The drawer itself needs the app shell; a probe lists the pages opened in it instead.
vi.mock('@renderer/components/tray/tray-manager', async () => {
  const { useFilePreview } = await import('@renderer/context/file-preview-context')
  return {
    TrayManager: () => {
      const { openTabs, isOpen } = useFilePreview()
      return (
        <ul data-testid="drawer-tabs" data-open={isOpen}>
          {openTabs.map((tab) => (
            <li key={tab.displayName}>{tab.kind === 'file' && tab.source ? `${tab.displayName} (own source)` : tab.displayName}</li>
          ))}
        </ul>
      )
    },
  }
})

import { TeamBrainOverview } from './team-brain-overview'
import { resetTeamBrainState } from '@renderer/lib/team-brain/team-brain-store'
import type { ApiAgent } from '@renderer/hooks/use-agents'

/** The Team Brain agent set-up made. */
const BRAIN: ApiAgent = {
  slug: 'team-brain', displaySlug: 'team-brain', name: 'Team Brain', status: 'running', avatar: null, teamBrain: { volumeId: 'vol1' }, createdAt: new Date(), containerPort: null,
}

beforeEach(() => {
  sessions.chats = []
  app.mount = 'ready'
  app.pollFailed = false
  resetTeamBrainState()
  upkeep.tasks = [task('t1', 'Nightly digest', 'pending'), task('t2', 'Weekly people check', 'paused')]
  screenSize.wide = true
  screenSize.listeners.clear()
  window.matchMedia = ((query: string) => ({
    get matches() { return query === '(min-width: 1280px)' ? screenSize.wide : false },
    media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: (_: string, listener: () => void) => screenSize.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => screenSize.listeners.delete(listener),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

/** Resize the window across xl. */
function setWide(wide: boolean) {
  screenSize.wide = wide
  act(() => screenSize.listeners.forEach((listener) => listener()))
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Object.assign(user, { isAuthMode: false, isAdmin: false })
})

describe('TeamBrainOverview', () => {
  it('shows the drive as a radial tree, and a page on its rim opens in the drawer', async () => {
    // jsdom lays nothing out; give the tree a card-sized box to fit and zoom in.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
    render(<TeamBrainOverview agent={BRAIN} />)
    // The tree is the page's centrepiece, with nothing round it to switch views. It opens by growing out from the middle.
    expect(screen.queryByTestId('team-brain-drive-folders')).toBeNull()
    const radial = screen.getByTestId('team-brain-radial')
    expect(radial).toHaveAttribute('data-entering', 'true')
    // Once open, it has settled on the whole tree (a touch before then would stop it where it is).
    await waitFor(() => expect(radial).not.toHaveAttribute('data-entering'), { timeout: 4000 })
    expect(within(radial).getByRole('img', { name: /radial tree of \d+ pages/ })).toBeInTheDocument()
    expect(within(radial).queryByTestId('team-brain-radial-node-/')).toBeNull()
    await userEvent.click(within(radial).getByTestId('team-brain-radial-node-customers/acme'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Acme Corp.md (own source)')
    // A page's name opens it as well as its dot.
    await userEvent.click(within(within(radial).getByTestId('team-brain-radial-node-customers/hooli')).getByText('Hooli'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Hooli.md (own source)')
    // So does the line to it, which also picks the page out on hover.
    const line = within(radial).getByTestId('team-brain-radial-branch-customers/northwind')
    await userEvent.hover(line)
    expect(within(within(radial).getByTestId('team-brain-radial-node-customers/northwind')).getByText('Northwind')).toHaveClass('font-medium')
    await userEvent.click(line)
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Northwind.md (own source)')
    await userEvent.unhover(line)

    // A folder clicked keeps its branch lit, turns round to three o'clock (on the ring, straight right of the middle) and zooms to its branch.
    const customers = within(radial).getByTestId('team-brain-radial-node-customers')
    const zoom = () => Number(radial.querySelector('svg > g')!.getAttribute('transform')?.match(/scale\(([\d.]+)\)/)?.[1] ?? 1)
    const fitted = zoom()
    await userEvent.click(customers)
    expect(customers).toHaveAttribute('data-selected', 'true')
    await waitFor(() => {
      const [x, y] = customers.getAttribute('transform')!.match(/-?[\d.]+/g)!.map(Number)
      expect(x).toBeGreaterThan(0)
      expect(Math.abs(y)).toBeLessThan(0.5)
    }, { timeout: 3000 })
    // Pages off the branch fade; a section's pill stays solid and only its name fades.
    expect(within(radial).getByTestId('team-brain-radial-node-engineering/architecture')).toHaveClass('opacity-10')
    expect(within(radial).getByTestId('team-brain-radial-node-engineering')).not.toHaveClass('opacity-10')
    expect(within(within(radial).getByTestId('team-brain-radial-pill-engineering')).getByText('Engineering')).toHaveClass('fill-muted-foreground/25')
    expect(zoom()).toBeGreaterThan(fitted)

    // The background lets it go and turns the tree back.
    await userEvent.click(within(radial).getByRole('img'))
    expect(customers).not.toHaveAttribute('data-selected')
    await waitFor(() => {
      const [, y] = customers.getAttribute('transform')!.match(/-?[\d.]+/g)!.map(Number)
      expect(Math.abs(y)).toBeGreaterThan(0.5)
      expect(zoom()).toBeCloseTo(fitted)
    }, { timeout: 3000 })
    width.mockRestore()
  })

  it('keeps its settings in a column beside the page: sync, schedule, where it lives, sources and agents', async () => {
    render(<TeamBrainOverview agent={BRAIN} />)
    // Details live in the settings drawer, opened from the settings button.
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')
    const details = within(screen.getByTestId('team-brain-details'))
    expect(details.getByText('Storage location')).toBeInTheDocument()
    // Where it lives comes from the Team Brain agent's own drive: folded, its home; open, where in it.
    expect(screen.getByTestId('team-brain-storage-section-toggle')).toHaveTextContent('Dropbox')
    expect(details.queryByText('Dropbox › Team Brain')).toBeNull()
    await userEvent.click(screen.getByTestId('team-brain-storage-section-toggle'))
    expect(details.getByText('Dropbox › Team Brain')).toBeInTheDocument()
    // The whole row opens it in Dropbox.
    await userEvent.click(screen.getByRole('button', { name: 'Open Team Brain drive settings' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/$tab', params: { tab: 'volumes' }, search: { volume: 'vol1', source: 'home', from: '/agents/team-brain' } })

    // Scheduled tasks are every one the agent has, by its id, whatever it is named: a row each for when it runs and how
    // often, which opens the task's own page to change the schedule or pause it.
    expect(screen.getByTestId('team-brain-status')).toHaveTextContent(/^Active$/)
    const nightly = within(screen.getByTestId('team-brain-sync-t1'))
    expect(nightly.getByText('Nightly digest')).toBeInTheDocument()
    expect(nightly.getByTestId('team-brain-sync-note')).toHaveTextContent(/^Syncs in (60 min|1 h) · last ran 2 h ago$/)
    expect(nightly.getByTestId('team-brain-schedule-runs')).toHaveTextContent(/^Runs [a-z].* · \S/)
    expect(nightly.getByTestId('team-brain-schedule')).toHaveTextContent('Daily')
    expect(within(screen.getByTestId('team-brain-sync-t2')).getByTestId('team-brain-schedule')).toHaveTextContent('Paused')
    await userEvent.click(screen.getByTestId('team-brain-sync-t1'))
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$slug/tasks/$taskId', params: { slug: 'team-brain', taskId: 't1' } })
    await userEvent.click(screen.getByTestId('team-brain-sync-t2'))
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$slug/tasks/$taskId', params: { slug: 'team-brain', taskId: 't2' } })
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')

    // Sources are the agent's connections, managed on its Connections page.
    await userEvent.click(within(screen.getByTestId('team-brain-sources')).getByRole('button', { name: /Sources/ }))
    expect(within(screen.getByTestId('team-brain-sources')).getByText('Acme workspace')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('team-brain-manage-sources'))
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$slug/connections', params: { slug: 'team-brain' }, search: undefined })

    // Agents are set-up's list, on the drive's attachments: a switch gives or takes Team Brain.
    await userEvent.click(within(screen.getByTestId('team-brain-agents')).getByRole('button', { name: /Agents/ }))
    expect(screen.getByTestId('team-brain-agent-writer')).toBeChecked()
    await userEvent.click(screen.getByTestId('team-brain-agent-planner'))
    expect(access.toggle).toHaveBeenCalledWith('planner', true)

    // A page opened from the tree takes the panel's place; the settings button brings it back and hides it again.
    await userEvent.click(screen.getByTestId('team-brain-radial-node-readme'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('README.md (own source)')
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'true')
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'false')
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'false')

    // Beside the page (a wide window), a click on the page leaves settings open; the settings button hides them.
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    await userEvent.click(screen.getByTestId('team-brain-status'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    // Floating over the page (a narrower window), where it covers the settings button, a click off it closes it;
    // a click in it does not.
    setWide(false)
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    await userEvent.click(screen.getByText('Storage location'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByTestId('team-brain-status'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'false')
    setWide(true)
    // A click on the page behind the file drawer puts it away; one on a page swaps the file and keeps it open.
    await userEvent.click(screen.getByTestId('team-brain-radial-node-readme'))
    await userEvent.click(screen.getByTestId('team-brain-sync-page-Customers/Acme Corp.md'))
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Acme Corp.md (own source)')
    await userEvent.click(screen.getByRole('heading', { name: 'Sync summaries' }))
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'false')

    // In the browser the tree holds the pointer from the press, so the click after it lands on the tree, not the page.
    const tree = screen.getByRole('img', { name: /radial tree/ })
    fireEvent.pointerDown(screen.getByTestId('team-brain-radial-node-customers/hooli'), { button: 0, pointerId: 1 })
    fireEvent.pointerUp(tree, { button: 0, pointerId: 1 })
    fireEvent.click(tree)
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Hooli.md (own source)')
    // A press on the background, though, is a click off the drawer.
    fireEvent.pointerDown(tree, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(tree, { button: 0, pointerId: 1 })
    fireEvent.click(tree)
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'false')
  })

  it('waits on the tree\'s middle while the drive lists, says what it is reading from, and lets that go before the tree', () => {
    vi.useFakeTimers()
    try {
      Object.assign(driveRead, { ready: false, error: null })
      const page = render(<TeamBrainOverview agent={BRAIN} />)
      const loading = screen.getByTestId('team-brain-radial-loading')
      expect(screen.queryByTestId('team-brain-radial-loading-line')).toBeNull()
      act(() => void vi.advanceTimersByTime(2000))
      expect(loading).toHaveTextContent('Reading Team Brain from Dropbox…')
      // The drive is in: the line plays back out first, and the tree only follows once it has gone.
      Object.assign(driveRead, { ready: true, error: null })
      page.rerender(<TeamBrainOverview agent={BRAIN} />)
      expect(screen.getByTestId('team-brain-radial-loading-line')).toHaveClass('team-brain-radial-out')
      expect(screen.queryByTestId('team-brain-radial')).toBeNull()
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByTestId('team-brain-radial')).toBeInTheDocument()
      expect(screen.queryByTestId('team-brain-radial-loading')).toBeNull()
    } finally {
      vi.useRealTimers()
      Object.assign(driveRead, { ready: true, error: null })
    }
  })

  it('says so at the top of the page when the drive cannot be read, whole or in part', () => {
    Object.assign(driveRead, { ready: false, error: 'Drive not available' })
    const { unmount } = render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-drive-error')).toHaveTextContent("Couldn't read the Team Brain drive. Drive not available")
    expect(screen.queryByTestId('team-brain-radial')).toBeNull()
    expect(screen.getByText('The tree shows once the drive can be read.')).toBeInTheDocument()
    unmount()
    // Up, with a folder that hung: the tree stays, and the banner says why in words.
    Object.assign(driveRead, { ready: true, error: 'signal timed out' })
    render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-drive-error')).toHaveTextContent("Couldn't read part of the Team Brain drive. It took too long to answer.")
    expect(screen.getByTestId('team-brain-radial')).toBeInTheDocument()
    Object.assign(driveRead, { ready: true, error: null })
  })

  it('shows the parts of the team record switched on in Views, each on its own', async () => {
    render(<TeamBrainOverview agent={BRAIN} />)
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    // Folded, it says how many views are on; open, a switch for each.
    expect(screen.getByTestId('team-brain-views-count')).toHaveTextContent('Off')
    expect(screen.queryByTestId('team-brain-view-rules')).toBeNull()
    await userEvent.click(screen.getByTestId('team-brain-views-toggle'))
    const views = within(screen.getByTestId('team-brain-views'))
    // Every usual part has its switch, written yet or not.
    expect(views.getAllByRole('switch').map((toggle) => toggle.id)).toEqual(
      ['rules', 'sources', 'changelog', 'archive', 'syncs', 'index'].map((view) => `team-brain-view-${view}`),
    )
    expect(views.getByLabelText(/^Show changelog/)).toBeInTheDocument()
    expect(within(views.getByText('Show changelog').closest('li')!).getByText('Not written yet')).toBeInTheDocument()
    expect(within(views.getByText('Show rules').closest('li')!).queryByText('Not written yet')).toBeNull()
    expect(driveRead.record.size).toBe(0)
    await userEvent.click(views.getByLabelText(/^Show sync summaries/))
    await userEvent.click(views.getByLabelText(/^Show agents' index/))
    expect([...driveRead.record]).toEqual(['syncs', 'index'])
    expect(screen.getByTestId('team-brain-views-count')).toHaveTextContent('2 on')
    await userEvent.click(views.getByLabelText(/^Show sync summaries/))
    expect([...driveRead.record]).toEqual(['index'])
  })

  it('is paused only when every scheduled task is, and says so when it has none', async () => {
    upkeep.tasks = [task('t2', 'Weekly people check', 'paused')]
    const page = render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-status')).toHaveTextContent(/^Paused$/)
    upkeep.tasks = []
    page.rerender(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-status')).toHaveTextContent(/^Not scheduled$/)
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('team-brain-sync-note')).toHaveTextContent('No scheduled tasks')
  })

  it('sums up each sync, and turns off by deleting the Team Brain agent', async () => {
    render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-overview')).toBeInTheDocument()
    // A composer to talk to it, for its agent.
    expect(screen.getByTestId('team-brain-composer')).toHaveTextContent('team-brain')
    // A page in the drive opens in the file drawer, from its own text.
    await userEvent.click(screen.getByTestId('team-brain-radial-node-readme'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('README.md (own source)')
    // Each sync is summed up like a changelog, newest first and marked Latest.
    const syncs = screen.getByTestId('team-brain-syncs')
    expect(within(syncs).getByRole('heading', { name: 'Sync summaries' })).toBeInTheDocument()
    const latest = within(syncs).getAllByRole('listitem')[0]
    expect(latest).toHaveTextContent('3 pages added, 9 updated')
    expect(latest).toHaveTextContent('Latest')
    expect(within(latest).getByRole('heading', { name: 'Acme’s renewal moves to Q1' })).toBeInTheDocument()
    // The latest says what needs a person, and its title opens the run's session.
    expect(within(latest).getByTestId('team-brain-sync-needs-you')).toHaveTextContent('Reconnect Slack.')
    await userEvent.click(within(latest).getByTestId('team-brain-sync-session-_brain/syncs/2026-10-23 0300.md'))
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$slug/sessions/$sessionId', params: { slug: 'team-brain', sessionId: 's-1' } })
    // A page named in a summary opens from the drive in the drawer.
    await userEvent.click(within(latest).getByTestId('team-brain-sync-page-Customers/Acme Corp.md'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Acme Corp.md (own source)')

    // The settings button opens the settings drawer, where turning off sits at the foot.
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(await screen.findByTestId('team-brain-turn-off'))
    await userEvent.click(await screen.findByTestId('team-brain-turn-off-confirm'))
    expect(app.deleteAgent).toHaveBeenCalledWith('team-brain', expect.anything())
  })

  it('leaves turning it off and who uses it to admins in a team workspace', async () => {
    Object.assign(user, { isAuthMode: true, isAdmin: false })
    render(<TeamBrainOverview agent={BRAIN} />)
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(await screen.findByTestId('team-brain-details')).toBeInTheDocument()
    expect(screen.queryByTestId('team-brain-turn-off')).toBeNull()
    await userEvent.click(screen.getByTestId('team-brain-agents-toggle'))
    expect(screen.getByTestId('team-brain-agent-writer')).toBeDisabled()
  })

  it('shows the latest sessions a person started under the composer, and See all opens the rest in place', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
    const chat = (id: string, h: number, extra = {}) => ({ id, agentSlug: 'team-brain', name: `Chat ${id}`, createdAt: hoursAgo(h + 1), lastActivityAt: hoursAgo(h), ...extra })
    sessions.chats = [
      chat('1', 1), chat('2', 2), chat('3', 3), chat('4', 4), chat('5', 5), chat('agent', 0, { origin: 'agent' }),
      chat('sync-waiting', 8, { name: 'Brain upkeep asks', origin: 'scheduled', isAwaitingInput: true }),
      chat('sync-done', 0, { name: 'Brain upkeep', origin: 'scheduled' }),
    ]
    render(<TeamBrainOverview agent={BRAIN} />)
    const recent = screen.getByTestId('team-brain-recent-sessions')
    const rows = () => within(recent).getAllByText(/^(Chat|Brain upkeep)/).map((row) => row.textContent)
    // The run waiting on someone, then the two newest chats; not other agents' messages or a finished sync.
    expect(rows()).toEqual(['Brain upkeep asks', 'Chat 1', 'Chat 2'])
    // It sits between the composer and the sync summaries.
    const composer = screen.getByTestId('team-brain-composer')
    const summaries = screen.getByTestId('team-brain-syncs')
    expect(composer.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(recent.compareDocumentPosition(summaries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await userEvent.click(within(recent).getByTestId('team-brain-see-all-sessions'))
    // Waiting stays first in the expanded list too.
    expect(rows()).toEqual(['Brain upkeep asks', 'Chat 1', 'Chat 2', 'Chat 3', 'Chat 4'])
    expect(within(recent).getByText('Page 1 of 2')).toBeInTheDocument()
    expect(screen.queryByTestId('team-brain-settings')).toBeNull()
    await userEvent.click(within(recent).getByTestId('team-brain-see-all-sessions'))
    expect(rows()).toHaveLength(3)
  })

  it('has no See all sessions while the recent ones are all there are', () => {
    sessions.chats = [{ id: '1', agentSlug: 'team-brain', name: 'Chat 1', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }]
    render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-recent-sessions')).toBeInTheDocument()
    expect(screen.queryByTestId('team-brain-see-all-sessions')).toBeNull()
  })

  it('reads nothing from a drive still making its first copy, and reads it once the copy is in', () => {
    // Before the drive list says whether it is copying, nothing is read either.
    app.mount = 'loading'
    const page = render(<TeamBrainOverview agent={BRAIN} />)
    expect(app.read).toEqual({ drive: undefined, syncs: undefined })
    app.mount = 'copying'
    driveRead.error = 'preparing'
    page.rerender(<TeamBrainOverview agent={BRAIN} />)
    expect(app.read).toEqual({ drive: undefined, syncs: undefined })
    expect(screen.queryByTestId('team-brain-drive-error')).toBeNull()
    // A drive list that fails after saying copying may be out of date: the drive answers for itself.
    app.pollFailed = true
    page.rerender(<TeamBrainOverview agent={BRAIN} />)
    expect(app.read.drive).toBe('vol1')
    app.pollFailed = false
    driveRead.error = null
    app.mount = 'ready'
    page.rerender(<TeamBrainOverview agent={BRAIN} />)
    expect(app.read).toEqual({ drive: 'vol1', syncs: 'vol1' })
  })

  it('has no recent sessions until someone starts one', () => {
    render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.queryByTestId('team-brain-recent-sessions')).toBeNull()
  })

  it('pages all its sessions five at a time once expanded', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
    sessions.chats = Array.from({ length: 14 }, (_, i) => ({ id: `${i + 1}`, agentSlug: 'team-brain', name: `Chat ${i + 1}`, createdAt: hoursAgo(i + 2), lastActivityAt: hoursAgo(i + 1) }))
    render(<TeamBrainOverview agent={BRAIN} />)
    const recent = screen.getByTestId('team-brain-recent-sessions')
    expect(within(recent).queryByText(/^Page /)).toBeNull()
    await userEvent.click(within(recent).getByTestId('team-brain-see-all-sessions'))
    expect(within(recent).getByText('Page 1 of 3')).toBeInTheDocument()
    expect(within(recent).getAllByText(/^Chat /)).toHaveLength(5)
    await userEvent.click(within(recent).getByRole('button', { name: 'Next page' }))
    await userEvent.click(within(recent).getByRole('button', { name: 'Next page' }))
    expect(within(recent).getAllByText(/^Chat /)).toHaveLength(4)
    await userEvent.click(within(recent).getByTestId('team-brain-see-all-sessions'))
    expect(within(recent).getAllByText(/^Chat /).map((row) => row.textContent)).toEqual(['Chat 1', 'Chat 2', 'Chat 3'])
    expect(within(recent).queryByText(/^Page /)).toBeNull()
    await userEvent.click(within(recent).getByTestId('team-brain-see-all-sessions'))
    expect(within(recent).getByText('Page 1 of 3')).toBeInTheDocument()
  })
})
