// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
let historyEntryKey = 'explore-entry'
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ state: { __TSR_key: historyEntryKey }, href: '/explore' }),
}))

const openSettings = vi.fn()
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings }) }))

let skillsets: { id: string; name: string }[] | undefined = []
let discoverable: ApiDiscoverableAgent[] | undefined
let isLoading = false
vi.mock('@renderer/hooks/use-skillsets', () => ({ useSkillsets: () => ({ data: skillsets }) }))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: discoverable, isLoading }),
  slugFromAgentPath: (path: string) => path.replace(/^agents\//, '').replace(/\/$/, ''),
}))

import { ExploreView } from './explore-view'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

function template(name: string, over: Partial<ApiDiscoverableAgent> = {}): ApiDiscoverableAgent {
  return {
    skillsetId: 'skillset-1',
    skillsetName: 'Public',
    name,
    description: `${name} does things`,
    version: '1.0.0',
    path: `agents/${name.toLowerCase().replace(/\s+/g, '-')}/`,
    category: 'Marketing',
    ...over,
  }
}

/** n templates in one category, so the section overflows its five-card preview. */
function roster(n: number, over: Partial<ApiDiscoverableAgent> = {}) {
  return Array.from({ length: n }, (_, i) => template(`Agent ${i + 1}`, over))
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  historyEntryKey = 'explore-entry'
  skillsets = [{ id: 'skillset-1', name: 'Public' }]
  discoverable = roster(9)
  isLoading = false
})

function getScrollContainer(): HTMLDivElement {
  const container = screen
    .getByTestId('explore-view')
    .closest('[data-scroll-restoration-id="explore-marketplace"]')
  if (!(container instanceof HTMLDivElement)) {
    throw new Error('Explore scroll container not found')
  }
  return container
}

describe('ExploreView scroll restoration', () => {
  it('restores its nested scroll position after opening a template', async () => {
    const firstRender = render(<ExploreView />)
    getScrollContainer().scrollTop = 640

    await userEvent.click(screen.getAllByTestId('explore-template-card')[0]!)
    expect(navigate).toHaveBeenCalledWith({
      to: '/explore/$skillsetId/$templateSlug',
      params: { skillsetId: 'skillset-1', templateSlug: 'agent-1' },
      state: { exploreReturnKey: historyEntryKey },
    })

    firstRender.unmount()
    render(<ExploreView />)
    expect(getScrollContainer().scrollTop).toBe(640)
  })
})

/**
 * The tile in a section's sixth slot is only ever a link to the category page,
 * so it always needs a call to action. Only the "+ N" remainder is conditional
 * — a section hiding no more than the three it names has nothing left to count,
 * which is exactly where Featured (eight first-party templates) lands.
 */
describe('ExploreView section overflow tile', () => {
  it('counts the remainder when more is hidden than named', () => {
    discoverable = roster(12) // 5 shown, 7 hidden, 3 of them named
    render(<ExploreView />)
    expect(within(screen.getByTestId('explore-see-more')).getByText('Show 4 more')).toBeTruthy()
  })

  it('still offers a way through when the tile names every hidden template', () => {
    discoverable = roster(8) // 5 shown, 3 hidden — all named, nothing to count
    render(<ExploreView />)
    const tile = screen.getByTestId('explore-see-more')
    expect(within(tile).queryByText(/Show \d+ more/)).toBeNull()
    expect(within(tile).getByText('See all')).toBeTruthy()
  })

  it('opens the category page from the tile', async () => {
    render(<ExploreView />)
    await userEvent.click(screen.getByTestId('explore-see-more'))
    expect(navigate).toHaveBeenCalledWith({
      to: '/explore/category/$category',
      params: { category: 'Marketing' },
    })
  })

  it('draws no tile when the section fits', () => {
    discoverable = roster(5)
    render(<ExploreView />)
    expect(screen.queryByTestId('explore-see-more')).toBeNull()
  })
})

/**
 * "Nothing checked" has to mean "no filter" for every filter on the page,
 * skillsets included — an empty set would strand the grid on zero results with
 * no chip on screen explaining why.
 */
describe('ExploreView skillset filter', () => {
  beforeEach(() => {
    skillsets = [
      { id: 'skillset-1', name: 'Public' },
      { id: 'skillset-2', name: 'Private' },
    ]
    // The filter offers the skillsets that actually contribute templates.
    discoverable = [
      template('From Public'),
      template('From Private', { skillsetId: 'skillset-2', skillsetName: 'Private' }),
    ]
  })

  it('narrows to one skillset, then falls back to all when the last is unchecked', async () => {
    render(<ExploreView />)
    await userEvent.click(screen.getByLabelText('Filter by skillset'))

    // Both start checked. Unchecking one leaves a real filter…
    await userEvent.click(await screen.findByText('Public'))
    expect(screen.getAllByTestId('explore-template-card').map((c) => c.textContent)).toEqual([
      expect.stringContaining('From Private'),
    ])

    // …and unchecking the last one means "no filter", not "match nothing".
    await userEvent.click(screen.getByText('Private'))
    expect(screen.getAllByTestId('explore-template-card')).toHaveLength(2)
  })
})

describe('ExploreView with no skillsets', () => {
  it('shows the empty state rather than a skeleton that never resolves', () => {
    skillsets = []
    discoverable = undefined
    render(<ExploreView />)
    expect(screen.getByTestId('explore-empty')).toBeTruthy()
  })

  it('shows a skeleton while the skillset list is still loading', () => {
    skillsets = undefined
    discoverable = undefined
    const { container } = render(<ExploreView />)
    expect(screen.queryByTestId('explore-empty')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })
})
