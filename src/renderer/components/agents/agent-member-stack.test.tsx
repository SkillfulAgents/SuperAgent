// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import { AgentMemberStack } from './agent-member-stack'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'

vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: vi.fn() }))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))
afterEach(cleanup)
const members: AgentMember[] = Array.from({ length: 8 }, (_, i) => ({ id: `member-${i}`, name: `Person ${i}`, email: `person-${i}@example.test`, image: null, role: i === 0 ? 'owner' : 'viewer' }))
function roster(count: number) {
  vi.mocked(useAgentMembers).mockReturnValue({ data: members.slice(0, count), isLoading: false, isError: false } as ReturnType<typeof useAgentMembers>)
}

describe('AgentMemberStack', () => {
  it.each([0, 1, 5, 8])('fits a roster of %i without exposing an invite action to readers', (count) => {
    roster(count)
    render(<AgentMemberStack agentSlug="agent-one" />)
    expect(screen.queryAllByTestId(/^agent-member-member-/)).toHaveLength(Math.min(count, 5))
    expect(screen.queryByTestId('agent-members-overflow') !== null).toBe(count > 5)
    expect(screen.queryByRole('button', { name: 'Share agent' })).toBeNull()
  })

  it('opens the full read-only roster from overflow and retains the separate invite control', () => {
    roster(8)
    render(<AgentMemberStack agentSlug="agent-one" inviteControl={<button>Share agent</button>} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 members' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByText('person-7@example.test')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share agent' })).toBeTruthy()
  })

  it('shows a name and email on keyboard focus and touch/click', async () => {
    roster(1)
    render(<AgentMemberStack agentSlug="agent-one" />)
    const face = screen.getByTestId('agent-member-member-0')
    fireEvent.focus(face)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('person-0@example.test')
    fireEvent.blur(face)
    fireEvent.click(face)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Person 0')
  })

  it('offers retry when the roster fails rather than presenting an empty roster', () => {
    const refetch = vi.fn()
    vi.mocked(useAgentMembers).mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch } as unknown as ReturnType<typeof useAgentMembers>)
    render(<AgentMemberStack agentSlug="agent-one" />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry members' }))
    expect(refetch).toHaveBeenCalledOnce()
    expect(screen.queryByText('No members')).toBeNull()
  })
})
