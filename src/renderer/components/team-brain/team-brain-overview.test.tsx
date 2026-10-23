// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { app, openExternalUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  app: {
    agents: [
      { slug: 'writer', displaySlug: 'writer', name: 'Writer', status: 'running', avatar: null },
      { slug: 'planner', displaySlug: 'planner', name: 'Planner', status: 'stopped', avatar: null },
    ],
    deleteAgent: vi.fn(),
  },
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useListedAgents: () => ({ data: app.agents }),
  useDeleteAgent: () => ({ mutate: app.deleteAgent, isPending: false }),
}))
// The Team Brain agent's own drive, in Dropbox.
vi.mock('@renderer/hooks/use-mounts', () => ({ useAgentMounts: () => ({ data: [{ id: 'm1', volumeId: 'vol1', name: 'Team Brain', type: 'dropbox' }] }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }))
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
import { resetTeamBrainLive } from '@renderer/lib/team-brain/team-brain-live'
import type { ApiAgent } from '@renderer/hooks/use-agents'

/** The Team Brain agent set-up made. */
const BRAIN: ApiAgent = {
  slug: 'team-brain', displaySlug: 'team-brain', name: 'Team Brain', status: 'running', avatar: null, teamBrain: true, createdAt: new Date(), containerPort: null,
}

beforeEach(() => {
  resetTeamBrainState()
  resetTeamBrainLive()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
    expect(within(radial).queryByTestId('team-brain-radial-node-team-brain')).toBeNull()
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

  it('keeps its settings in a drawer: sync, schedule, where it lives, sources and agents', async () => {
    render(<TeamBrainOverview agent={BRAIN} />)
    // Details live in the settings drawer, opened from the settings button.
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')
    const details = within(screen.getByTestId('team-brain-details'))
    expect(details.getByText('Storage location')).toBeInTheDocument()
    // Where it lives comes from the Team Brain agent's own drive.
    expect(details.getByText('Dropbox › Team Brain')).toBeInTheDocument()
    // The storage location opens where it lives.
    await userEvent.click(screen.getByRole('button', { name: 'Open Team Brain in Dropbox' }))
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.dropbox.com/home/Team%20Brain')
    expect(details.getByText('Next:')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('switch', { name: 'Pause syncing' }))
    expect(screen.getByTestId('team-brain-status')).toHaveTextContent('Paused · Synced')
    expect(details.getAllByText('Paused').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('switch', { name: 'Resume syncing' }))
    expect(screen.getByTestId('team-brain-status')).toHaveTextContent('Active · Synced')

    // The schedule is picked here too, from a row like Agent Home's default model, with what each choice costs.
    expect(screen.getByTestId('team-brain-schedule-trigger')).toHaveTextContent('Daily')
    await userEvent.click(screen.getByTestId('team-brain-schedule-trigger'))
    expect(screen.getByRole('option', { name: /^Daily/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: /^Weekly/ })).toHaveTextContent(/Cheapest/)
    await userEvent.click(screen.getByTestId('team-brain-schedule-option-weekly'))
    expect(screen.getByRole('option', { name: /^Weekly/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('team-brain-schedule-trigger')).toHaveTextContent('Weekly')
    // Escape puts the picker away and leaves the drawer open.
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Schedule' })).toBeNull()
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')

    // A page opened from the tree takes the drawer's place; Settings brings it back, and its own button hides it.
    await userEvent.click(screen.getByTestId('team-brain-radial-node-readme'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('README.md (own source)')
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'true')
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('drawer-tabs')).toHaveAttribute('data-open', 'false')
    await userEvent.click(screen.getByTestId('team-brain-settings-close'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'false')

    // A click on the page behind a drawer puts it away; one on a page swaps the file and keeps it open.
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    await userEvent.click(screen.getByTestId('team-brain-status'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(screen.getByTestId('team-brain-radial-node-readme'))
    await userEvent.click(screen.getByTestId('team-brain-sync-page-customers/acme'))
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

  it('sums up each sync, and turns off by deleting the Team Brain agent', async () => {
    render(<TeamBrainOverview agent={BRAIN} />)
    expect(screen.getByTestId('team-brain-overview')).toBeInTheDocument()
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
    // What an agent told Team Brain is credited to a real agent that uses it.
    expect(latest).toHaveTextContent('Writer told Team Brain what it learned about the pricing change; it is filed as 0009 Pricing change.')
    // A page named in a summary opens in the drawer.
    await userEvent.click(within(latest).getByTestId('team-brain-sync-page-customers/acme'))
    expect(screen.getByTestId('drawer-tabs')).toHaveTextContent('Acme Corp.md (own source)')

    // The settings button opens the settings drawer, where turning off sits at the foot.
    await userEvent.click(screen.getByTestId('team-brain-menu'))
    expect(screen.getByTestId('team-brain-menu')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(await screen.findByTestId('team-brain-turn-off'))
    await userEvent.click(await screen.findByTestId('team-brain-turn-off-confirm'))
    expect(app.deleteAgent).toHaveBeenCalledWith('team-brain', expect.anything())
  })
})
