// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ApiAgent } from '@shared/lib/types/api'

const state = vi.hoisted(() => ({
  agents: [] as unknown[],
  settings: undefined as unknown,
}))

vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: state.agents }) }))
vi.mock('@renderer/hooks/use-user-settings', () => ({ useUserSettings: () => ({ data: state.settings }) }))

import { AgentDropdown, agentDropdownSections } from './agent-dropdown'

function agent(slug: string, name: string, createdAt = 0): ApiAgent {
  return { slug, displaySlug: slug, name, createdAt: new Date(createdAt), status: 'stopped', containerPort: null }
}

const AGENTS = [agent('ops', 'Ops Agent'), agent('research', 'Research Agent'), agent('market', 'Marketing Agent')]

beforeEach(() => {
  // jsdom has no layout; the list scrolls the active option into view.
  Element.prototype.scrollIntoView = vi.fn()
  state.agents = AGENTS
  state.settings = undefined
})

function open(props: Partial<Parameters<typeof AgentDropdown>[0]> = {}) {
  const onValueChange = vi.fn()
  renderWithProviders(<AgentDropdown value={null} onValueChange={onValueChange} {...props} />)
  fireEvent.click(screen.getByTestId('agent-dropdown'))
  return onValueChange
}

const optionNames = () => screen.getAllByRole('option').map((o) => o.textContent)

describe('agentDropdownSections', () => {
  it('follows the sidebar: its order, then its folders in their order', () => {
    const sections = agentDropdownSections(AGENTS, {
      agentOrder: ['research', 'market', 'ops'],
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { market: 'f1' },
      agentListOrder: ['agent-folder::f1', 'agent-folder::root'],
    })
    expect(sections.map((s) => [s.folder.name, s.agents.map((a) => a.slug)])).toEqual([
      ['Work', ['market']],
      ['Your Agents', ['research', 'ops']],
    ])
  })

  it('searches names ignoring case and drops folders left empty', () => {
    const sections = agentDropdownSections(AGENTS, {
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { market: 'f1' },
    }, '  OPS ')
    expect(sections.map((s) => [s.folder.name, s.agents.map((a) => a.slug)])).toEqual([['Your Agents', ['ops']]])
  })
})

describe('AgentDropdown', () => {
  it('lists agents in the sidebar order, with no sections when there are no folders', () => {
    state.settings = { agentOrder: ['research', 'ops', 'market'] }
    open()
    expect(optionNames()).toEqual(['Research Agent', 'Ops Agent', 'Marketing Agent'])
    expect(screen.queryByText('Your Agents')).not.toBeInTheDocument()
  })

  it('shows folders as sections when there is more than one', () => {
    state.settings = { agentFolders: [{ id: 'f1', name: 'Work' }], agentFolderAssignments: { market: 'f1' } }
    open()
    expect(within(screen.getByRole('group', { name: 'Work' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Marketing Agent'])
    expect(screen.getByRole('group', { name: 'Your Agents' })).toBeInTheDocument()
  })

  it('filters as you type, ignoring case, and highlights the match', () => {
    open()
    fireEvent.change(screen.getByTestId('agent-dropdown-search'), { target: { value: 'aGeNt' } })
    expect(optionNames()).toHaveLength(3)
    fireEvent.change(screen.getByTestId('agent-dropdown-search'), { target: { value: 'SEARCH' } })
    expect(optionNames()).toEqual(['Research Agent'])
    const highlighted = screen.getByRole('option').querySelector('.bg-yellow-200')
    expect(highlighted?.textContent).toBe('search')
    fireEvent.change(screen.getByTestId('agent-dropdown-search'), { target: { value: 'nobody' } })
    expect(screen.getByText('No agents found.')).toBeInTheDocument()
  })

  it('picks with the keyboard', () => {
    const onValueChange = open()
    const search = screen.getByTestId('agent-dropdown-search')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledWith('research', expect.objectContaining({ name: 'Research Agent' }))
  })

  it('picks with a click, marks the selected agent, and offers only what the filter allows', () => {
    const onValueChange = open({ value: 'ops', filter: (a: ApiAgent) => a.slug !== 'market' })
    expect(optionNames()).toEqual(['Ops Agent', 'Research Agent'])
    expect(screen.getByRole('option', { name: 'Ops Agent' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('option', { name: 'Research Agent' }))
    expect(onValueChange).toHaveBeenCalledWith('research', expect.objectContaining({ slug: 'research' }))
  })

  it('shows the selected agent, or the placeholder, on its button', () => {
    renderWithProviders(<AgentDropdown value="research" onValueChange={vi.fn()} />)
    expect(screen.getByTestId('agent-dropdown')).toHaveTextContent('Research Agent')
  })
})
