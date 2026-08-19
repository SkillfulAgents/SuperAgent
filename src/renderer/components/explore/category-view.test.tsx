// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const openSettings = vi.fn()
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings }) }))

let skillsets: { id: string }[] | undefined = []
let discoverable: ApiDiscoverableAgent[] | undefined
let isLoading = false
vi.mock('@renderer/hooks/use-skillsets', () => ({ useSkillsets: () => ({ data: skillsets }) }))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: discoverable, isLoading }),
  slugFromAgentPath: (path: string) => path.replace(/^agents\//, '').replace(/\/$/, ''),
}))

import { CategoryView } from './category-view'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const marketing: ApiDiscoverableAgent = {
  skillsetId: 'skillset-1',
  skillsetName: 'Public',
  name: 'Campaign Writer',
  description: 'Writes campaigns',
  version: '1.0.0',
  path: 'agents/campaign-writer/',
  category: 'Marketing',
}

beforeEach(() => {
  vi.clearAllMocks()
  skillsets = [{ id: 'skillset-1' }]
  discoverable = [marketing]
  isLoading = false
})

describe('CategoryView', () => {
  it('lists the templates in the category', () => {
    render(<CategoryView category="Marketing" />)
    expect(screen.getAllByTestId('explore-template-card')).toHaveLength(1)
  })

  it('treats Featured as a category, keyed off the developer', () => {
    discoverable = [
      marketing,
      { ...marketing, name: 'First Party', developer: { name: 'SkillfulAgents' } },
    ]
    render(<CategoryView category="Featured" />)
    const cards = screen.getAllByTestId('explore-template-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('First Party')
  })

  // `useDiscoverableAgents` is `enabled: hasSkillsets`, so with none configured
  // its data never arrives — a page branching on the data alone renders a
  // skeleton forever.
  it('shows the empty state rather than a skeleton that never resolves', () => {
    skillsets = []
    discoverable = undefined
    render(<CategoryView category="Marketing" />)
    expect(screen.getByTestId('explore-empty')).toBeTruthy()
  })

  it('distinguishes an empty category from having no skillsets at all', () => {
    render(<CategoryView category="Recruiting" />)
    expect(screen.queryByTestId('explore-empty')).toBeNull()
    expect(screen.getByText('No templates in Recruiting.')).toBeTruthy()
  })

  it('shows a skeleton while the skillset list is still loading', () => {
    skillsets = undefined
    discoverable = undefined
    const { container } = render(<CategoryView category="Marketing" />)
    expect(screen.queryByTestId('explore-empty')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })
})
