// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { SidebarMemberIndicator } from './sidebar-member-indicator'

vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: vi.fn() }))
vi.mock('@renderer/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))

const members: AgentMember[] = Array.from({ length: 6 }, (_, i) => ({
  id: `member-${i}`, name: `Person ${i}`, email: `person-${i}@example.test`, image: null,
  role: i === 0 ? 'owner' : 'viewer',
}))
const props = { agentSlug: 'shared-agent', agentName: 'Shared Agent', memberCount: 6 }
const refetch = vi.fn()
function roster(data: AgentMember[] | undefined, state = { isLoading: false, isError: false }) {
  vi.mocked(useAgentMembers).mockReturnValue({ data, ...state, refetch } as unknown as ReturnType<typeof useAgentMembers>)
}
beforeEach(() => { vi.clearAllMocks(); roster(members) })
afterEach(cleanup)

describe('SidebarMemberIndicator', () => {
  it.each([
    { count: 3, faces: 3, overflow: null },
    { count: 4, faces: 2, overflow: '+2' },
    { count: 6, faces: 2, overflow: '+4' },
  ])('represents a $count-member team within three circles', ({ count, faces, overflow }) => {
    roster(members.slice(0, count))
    render(<SidebarMemberIndicator {...props} memberCount={count} />)
    const trigger = screen.getByRole('button', { name: `${count} members of Shared Agent` })
    expect(within(trigger).getAllByRole('img', { hidden: true })).toHaveLength(faces)
    if (overflow) expect(trigger).toHaveTextContent(overflow)
    else expect(trigger).not.toHaveTextContent('+')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('listitem')).toHaveLength(count)
    expect(screen.getByText(`person-${count - 1}@example.test`)).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('button')).toBeNull()
  })

  it('counts the overflow circle toward the configurable limit', () => {
    const { rerender } = render(<SidebarMemberIndicator {...props} maxFaces={1} />)
    const trigger = screen.getByRole('button', { name: '6 members of Shared Agent' })
    expect(within(trigger).queryAllByRole('img', { hidden: true })).toHaveLength(0)
    expect(trigger).toHaveTextContent('+6')
    fireEvent.click(trigger)
    rerender(<SidebarMemberIndicator {...props} maxFaces={4} />)
    expect(within(trigger).getAllByRole('img', { hidden: true })).toHaveLength(3)
    expect(trigger).toHaveTextContent('+3')
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('shows loading state and fills an already-open roster when members arrive', () => {
    roster(undefined, { isLoading: true, isError: false })
    const { rerender } = render(<SidebarMemberIndicator {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '6 members of Shared Agent' }))
    expect(screen.getByRole('status')).toHaveTextContent('Loading members')
    roster(members)
    rerender(<SidebarMemberIndicator {...props} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('allows a failed roster request to be retried', () => {
    roster(undefined, { isLoading: false, isError: true })
    render(<SidebarMemberIndicator {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '6 members of Shared Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry members' }))
    expect(refetch).toHaveBeenCalledOnce()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('does not pass trigger activation to the sortable row', () => {
    const startDrag = vi.fn()
    render(<div role="button" tabIndex={0} aria-label="Drag agent" onPointerDown={startDrag} onKeyDown={startDrag}><SidebarMemberIndicator {...props} /></div>)
    const trigger = screen.getByRole('button', { name: '6 members of Shared Agent' })
    fireEvent.pointerDown(trigger)
    fireEvent.keyDown(trigger, { key: ' ', code: 'Space' })
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    fireEvent.click(trigger)
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('updates an open roster and hides it when the agent becomes private', () => {
    const { rerender } = render(<SidebarMemberIndicator {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '6 members of Shared Agent' }))
    roster(members.slice(0, 3).map(member => member.id === 'member-1' ? { ...member, name: 'Updated Person' } : member))
    rerender(<SidebarMemberIndicator {...props} />)
    expect(screen.getByText('Updated Person')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '3 members of Shared Agent' })).not.toHaveTextContent('+')
    roster(members.slice(0, 1))
    rerender(<SidebarMemberIndicator {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })
})
