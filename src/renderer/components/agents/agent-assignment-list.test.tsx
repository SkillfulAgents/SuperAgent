// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentAssignmentList } from './agent-assignment-list'

const agents = [{ slug: 'a', name: 'Research', displaySlug: 'research-a' }, { slug: 'b', name: 'Reports', displaySlug: 'reports-b' }]
const props = {
  agents, assignedSlugs: [] as string[], sectioned: true,
  toggleLabel: (agent: typeof agents[number], assigned: boolean) => `${assigned ? 'Remove' : 'Add'} ${agent.name}`,
  testId: (slug: string) => `toggle-${slug}`,
}
afterEach(() => { cleanup(); Reflect.deleteProperty(document, 'startViewTransition') })

describe('shared agent assignments', () => {
  it('allows independent toggles in flight and reconciles them after refetch', async () => {
    const resolvers = new Map<string, () => void>()
    const toggle = vi.fn((slug: string) => new Promise<void>(resolve => resolvers.set(slug, resolve)))
    const view = render(<AgentAssignmentList {...props} onToggle={toggle} />)
    await userEvent.click(screen.getByRole('switch', { name: 'Add Research' }))
    expect(screen.getByLabelText('Updating Research')).toBeVisible()
    await userEvent.click(screen.getByRole('switch', { name: 'Add Reports' }))
    expect(toggle.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
    view.rerender(<AgentAssignmentList {...props} assignedSlugs={['a', 'b']} onToggle={toggle} />)
    await act(async () => { for (const resolve of resolvers.values()) resolve() })
    expect(screen.getByRole('switch', { name: 'Remove Research' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remove Reports' })).toBeChecked()
    expect(screen.queryByText('Agents Without Access')).not.toBeInTheDocument()
  })
  it('queues rollback after a deferred optimistic animation when the request immediately fails', async () => {
    const transitions: (() => void)[] = []
    Object.assign(document, { startViewTransition: vi.fn((update: () => void) => transitions.push(update)) })
    const toggle = vi.fn().mockRejectedValue(new Error('Permission denied'))
    render(<AgentAssignmentList {...props} onToggle={toggle} />)
    await userEvent.click(screen.getByRole('switch', { name: 'Add Research' }))
    await waitFor(() => expect(transitions).toHaveLength(2))
    act(() => { transitions[0](); transitions[1]() })
    expect(screen.getByRole('switch', { name: 'Add Research' })).not.toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('Permission denied')
  })
  it('does not present unavailable assignment data as all agents being unassigned', () => {
    render(<AgentAssignmentList {...props} error={new Error('Could not load assignments')} onToggle={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load assignments')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
