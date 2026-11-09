// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
let historyEntryKey = 'explore-entry'
let search: { library?: string } = {}
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ state: { __TSR_key: historyEntryKey }, href: '/explore' }),
}))

const openSettings = vi.fn()
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings }) }))

let skillsets: { id: string; name: string }[] | undefined = []
let discoverable: ApiDiscoverableAgent[] | undefined
let isLoading = false
let isError = false
vi.mock('@renderer/hooks/use-skillsets', () => ({ useSkillsets: () => ({ data: skillsets }) }))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: discoverable, isLoading, isError }),
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
  search = {}
  sessionStorage.clear()
  historyEntryKey = 'explore-entry'
  skillsets = [{ id: 'skillset-1', name: 'Public' }]
  discoverable = roster(9)
  isLoading = false
  isError = false
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
      search: { library: 'skillset-1' },
    })
  })

  it('draws no tile when the section fits', () => {
    discoverable = roster(5)
    render(<ExploreView />)
    expect(screen.queryByTestId('explore-see-more')).toBeNull()
  })
})

/**
 * The heading reads "Library: <name>" and the page shows one library at a time
 * — there is no "all". More than one library contributing templates turns the
 * name into a menu of them; one library is a plain heading.
 */
describe('ExploreView library selector', () => {
  beforeEach(() => {
    // Configured order decides which library opens first.
    skillsets = [
      { id: 'skillset-1', name: 'Public' },
      { id: 'skillset-2', name: 'Private' },
    ]
    // Name order would put Private first; configured order must win.
    discoverable = [
      template('From Private', { skillsetId: 'skillset-2', skillsetName: 'Private' }),
      template('From Public'),
    ]
  })

  const cardNames = () =>
    screen.getAllByTestId('explore-template-card').map((c) => c.textContent)

  it('opens on the first configured library', () => {
    render(<ExploreView />)
    expect(screen.getByTestId('explore-library-select')).toHaveTextContent('Public')
    expect(cardNames()).toEqual([expect.stringContaining('From Public')])
  })

  it('switches library through the URL, offering no all option', async () => {
    const user = userEvent.setup()
    render(<ExploreView />)
    await user.click(screen.getByTestId('explore-library-select'))

    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Public'),
      expect.stringContaining('Private'),
    ])

    await user.click(screen.getByRole('menuitem', { name: /Private/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/explore',
      search: { library: 'skillset-2' },
      replace: true,
    })
  })

  it('shows the library the URL names', () => {
    search = { library: 'skillset-2' }
    render(<ExploreView />)
    expect(screen.getByTestId('explore-library-select')).toHaveTextContent('Private')
    expect(cardNames()).toEqual([expect.stringContaining('From Private')])
  })

  it('falls back to the first library when the URL names one with no templates', () => {
    search = { library: 'gone' }
    render(<ExploreView />)
    expect(cardNames()).toEqual([expect.stringContaining('From Public')])
  })

  it('names a single library in a plain heading', () => {
    discoverable = [template('From Public')]
    render(<ExploreView />)
    expect(screen.queryByTestId('explore-library-select')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Library: Public' })).toBeTruthy()
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

  it('settles to the empty state when the template fetch fails', () => {
    // After react-query gives up, data stays undefined with isLoading false —
    // without the hook's isError term this page would skeleton forever.
    discoverable = undefined
    isError = true
    const { container } = render(<ExploreView />)
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(screen.getByTestId('explore-empty')).toBeTruthy()
  })
})
