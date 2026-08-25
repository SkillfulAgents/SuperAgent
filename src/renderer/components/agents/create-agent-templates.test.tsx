// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

let skillsets: { id: string; name: string }[] | undefined = []
let discoverable: ApiDiscoverableAgent[] | undefined
let isLoading = false
vi.mock('@renderer/hooks/use-skillsets', () => ({ useSkillsets: () => ({ data: skillsets }) }))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: discoverable, isLoading }),
}))
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings: vi.fn() }) }))

import { CreateAgentTemplates } from './create-agent-templates'
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

function roster(n: number, over: Partial<ApiDiscoverableAgent> = {}) {
  return Array.from({ length: n }, (_, i) => template(`Agent ${i + 1}`, over))
}

beforeEach(() => {
  vi.clearAllMocks()
  skillsets = [{ id: 'skillset-1', name: 'Public' }]
  discoverable = roster(7)
  isLoading = false
})

describe('CreateAgentTemplates', () => {
  it('renders stacked category sections: five cards plus the see-more tile', () => {
    render(<CreateAgentTemplates onSelect={vi.fn()} />)

    expect(screen.getByText('Marketing')).toBeInTheDocument()
    expect(screen.getAllByTestId('explore-template-card')).toHaveLength(5)
    expect(screen.getByTestId('explore-see-more')).toBeInTheDocument()
  })

  it('see-more finishes the wizard, then opens the Explore category page', async () => {
    const user = userEvent.setup()
    // Ordering is the contract: the wizard overlay sits above the router, so
    // navigating before onNavigateAway resolves lands on a page it covers.
    const order: string[] = []
    const onNavigateAway = vi.fn(async () => { order.push('away') })
    navigate.mockImplementation(() => order.push('navigate'))
    discoverable = roster(9)
    render(<CreateAgentTemplates onSelect={vi.fn()} onNavigateAway={onNavigateAway} />)

    await user.click(screen.getByTestId('explore-see-more'))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/explore/category/$category',
        params: { category: 'Marketing' },
      }),
    )
    expect(order).toEqual(['away', 'navigate'])
  })

  it('still leaves for the category page when the navigate-away hook rejects', async () => {
    const user = userEvent.setup()
    discoverable = roster(9)
    render(
      <CreateAgentTemplates
        onSelect={vi.fn()}
        onNavigateAway={vi.fn(async () => { throw new Error('settings PUT failed') })}
      />,
    )

    await user.click(screen.getByTestId('explore-see-more'))

    await waitFor(() => expect(navigate).toHaveBeenCalled())
  })

  it('leads with Featured, keeping first-party templates in their category too', () => {
    discoverable = [
      template('Community One'),
      template('First Party', { developer: { name: 'SkillfulAgents' } }),
    ]
    render(<CreateAgentTemplates onSelect={vi.fn()} />)

    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(headings).toEqual(['Featured', 'Marketing'])
    expect(within(screen.getByTestId('create-agent-templates')).getAllByText('First Party')).toHaveLength(2)
  })

  it('hands the clicked template back to the caller', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    discoverable = [template('Inbox Zero')]
    render(<CreateAgentTemplates onSelect={onSelect} />)

    // By accessible name: unlike Explore (where a card opens a details page),
    // clicking here installs in place, and the card must say so.
    await user.click(screen.getByRole('button', { name: 'Inbox Zero — install' }))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Inbox Zero' }))
  })

  it('previews three cards per section on mobile widths', () => {
    // useIsMobile reads window.innerWidth against its 768px line.
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 500 })
    try {
      render(<CreateAgentTemplates onSelect={vi.fn()} />)

      expect(screen.getAllByTestId('explore-template-card')).toHaveLength(3)
      expect(screen.getByTestId('explore-see-more')).toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: original })
    }
  })

  it('renders the import tile after the last section when wired', async () => {
    const user = userEvent.setup()
    const onImportClick = vi.fn()
    render(<CreateAgentTemplates onSelect={vi.fn()} onImportClick={onImportClick} />)

    const container = screen.getByTestId('create-agent-templates')
    const tile = screen.getByTestId('import-agent-card')
    expect(container.lastElementChild?.lastElementChild).toBe(tile)

    await user.click(tile)
    expect(onImportClick).toHaveBeenCalledOnce()
  })

  it('omits the import tile when no handler is wired', () => {
    render(<CreateAgentTemplates onSelect={vi.fn()} />)
    expect(screen.queryByTestId('import-agent-card')).not.toBeInTheDocument()
  })

  it('renders nothing when no skillset supplies templates', () => {
    skillsets = []
    discoverable = []
    const { container } = render(<CreateAgentTemplates onSelect={vi.fn()} />)

    // Deliberately silent rather than an empty state — the composer above is
    // already a complete way to create an agent.
    expect(container).toBeEmptyDOMElement()
  })
})
