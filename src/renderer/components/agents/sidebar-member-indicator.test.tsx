// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import type { AgentMemberAgent } from '@shared/lib/types/inbound-x-agent-schema'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { useAgentMemberAgents } from '@renderer/hooks/use-agent-member-agents'
import { AgentSharePopover } from './agent-share-popover'
import { SidebarMemberIndicator } from './sidebar-member-indicator'

vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: vi.fn() }))
vi.mock('@renderer/hooks/use-agent-member-agents', () => ({ useAgentMemberAgents: vi.fn() }))
vi.mock('@renderer/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))
vi.mock('./agent-share-popover', () => ({ AgentSharePopover: vi.fn(({ trigger }) => trigger) }))
const user = { isAuthMode: true, isAdmin: false, canAdminAgent: vi.fn((_slug: string) => false) }
vi.mock('@renderer/context/user-context', () => ({ useUser: () => user }))

const members: AgentMember[] = Array.from({ length: 6 }, (_, i) => ({
  id: `member-${i}`, name: `Person ${i}`, email: `person-${i}@example.test`, image: null,
  role: i === 0 ? 'owner' : 'viewer',
}))
const memberAgents: AgentMemberAgent[] = [
  { slug: 'triage', name: 'Inbox Triage', avatar: { color: 'tonal-amber', shape: 'circle' } as const, role: 'user' },
  { slug: 'notes', name: 'Release Notes', avatar: null, role: 'viewer' },
]
const props = { agentSlug: 'shared-agent', agentName: 'Shared Agent', memberCount: 6 }
const refetch = vi.fn()
function roster(data: AgentMember[] | undefined, state = { isLoading: false, isError: false }) {
  vi.mocked(useAgentMembers).mockReturnValue({ data, ...state, refetch } as unknown as ReturnType<typeof useAgentMembers>)
}
beforeEach(() => {
  vi.clearAllMocks()
  user.isAuthMode = true
  user.isAdmin = false
  user.canAdminAgent.mockReturnValue(false)
  roster(members)
  vi.mocked(useAgentMemberAgents).mockReturnValue([])
})
afterEach(cleanup)

describe('SidebarMemberIndicator', () => {
  it.each([
    { isAdmin: false, isOwner: true, canInvite: true },
    { isAdmin: true, isOwner: false, canInvite: true },
    { isAdmin: false, isOwner: false, canInvite: false },
  ])('offers invitations for owner=$isOwner, admin=$isAdmin', ({ isAdmin, isOwner, canInvite }) => {
    user.isAdmin = isAdmin
    user.canAdminAgent.mockImplementation(slug => slug === props.agentSlug && isOwner)
    render(<SidebarMemberIndicator {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '6 members of Shared Agent' }))
    if (canInvite) {
      expect(screen.getByRole('button', { name: 'Invite' })).toBeVisible()
      expect(vi.mocked(AgentSharePopover).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        agentSlug: props.agentSlug,
        agentName: props.agentName,
      }))
    } else {
      expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
      expect(AgentSharePopover).not.toHaveBeenCalled()
    }
  })

  it.each([
    { count: 3, faces: 3, overflow: null },
    { count: 4, faces: 4, overflow: null },
    { count: 5, faces: 3, overflow: '5' },
    { count: 6, faces: 3, overflow: '6' },
  ])('represents a $count-member team within four circles', ({ count, faces, overflow }) => {
    roster(members.slice(0, count))
    render(<SidebarMemberIndicator {...props} memberCount={count} />)
    const trigger = screen.getByRole('button', { name: `${count} members of Shared Agent` })
    expect(within(trigger).getAllByRole('img', { hidden: true })).toHaveLength(faces)
    const total = within(trigger).queryByTestId('sidebar-members-count-shared-agent')
    if (overflow) expect(total).toHaveTextContent(overflow)
    else expect(total).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getAllByRole('listitem')).toHaveLength(count)
    expect(screen.getByText(`person-${count - 1}@example.test`)).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('button')).toBeNull()
  })

  it('counts member agents after the people and lists them in the roster', () => {
    roster(members.slice(0, 1))
    vi.mocked(useAgentMemberAgents).mockReturnValue(memberAgents)
    render(<SidebarMemberIndicator {...props} memberCount={1} />)
    // One person alone would be private: the agents are what make it shared.
    expect(vi.mocked(useAgentMembers)).toHaveBeenCalledWith(props.agentSlug, true)
    fireEvent.click(screen.getByRole('button', { name: '3 members of Shared Agent' }))
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'P0Person 0person-0@example.testowner',
      'Inbox Triageuser',
      'Release Notesviewer',
    ])
  })

  it('alternates people and agents in the circles, so agents read as members', () => {
    roster(members.slice(0, 3))
    vi.mocked(useAgentMemberAgents).mockReturnValue(memberAgents)
    render(<SidebarMemberIndicator {...props} memberCount={3} />)
    const trigger = screen.getByRole('button', { name: '5 members of Shared Agent' })
    // Four circles for five members: three faces and the count. Person, agent, person.
    const people = within(trigger).getAllByRole('img', { hidden: true })
    const agent = trigger.querySelector('[data-avatar-orb]')!
    expect(people.map((face) => face.getAttribute('aria-label'))).toEqual(['Person 0', 'Person 1'])
    expect(people[0].compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(agent.compareDocumentPosition(people[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(trigger).getByTestId('sidebar-members-count-shared-agent')).toHaveTextContent('5')
  })

  it('keeps a loaded roster for a viewer who is not one of the agent\'s people', () => {
    // A deployment admin removed from the agent: no people count of their own.
    roster(members.slice(0, 4))
    render(<SidebarMemberIndicator {...props} memberCount={0} />)
    expect(vi.mocked(useAgentMembers)).toHaveBeenCalledWith(props.agentSlug, false)
    const trigger = screen.getByRole('button', { name: '4 members of Shared Agent' })
    expect(within(trigger).getAllByRole('img', { hidden: true })).toHaveLength(4)
  })

  it('stays hidden for one person and no agents', () => {
    roster(members.slice(0, 1))
    render(<SidebarMemberIndicator {...props} memberCount={1} />)
    expect(vi.mocked(useAgentMembers)).toHaveBeenCalledWith(props.agentSlug, false)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the agents alone on a local install, where anyone can invite', () => {
    user.isAuthMode = false
    roster(undefined)
    vi.mocked(useAgentMemberAgents).mockReturnValue(memberAgents.slice(0, 1))
    render(<SidebarMemberIndicator {...props} memberCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: '1 member of Shared Agent' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Invite' })).toBeVisible()
  })

  it('gives Agent Home its own size, test ids and five circles', () => {
    render(<SidebarMemberIndicator {...props} variant="page" maxFaces={5} />)
    const trigger = screen.getByTestId('agent-members-shared-agent')
    const faces = within(trigger).getAllByRole('img', { hidden: true })
    expect(faces).toHaveLength(4)
    expect(faces[0]).toHaveStyle({ width: '24px' })
    expect(within(trigger).getByTestId('agent-members-count-shared-agent')).toHaveTextContent('6')
    fireEvent.click(trigger)
    expect(screen.getByTestId('agent-members-list-shared-agent')).toBeInTheDocument()
  })

  it('keeps the first roster open when pressing Invite blurs the avatar trigger', () => {
    user.canAdminAgent.mockReturnValue(true)
    render(<SidebarMemberIndicator {...props} />)
    const trigger = screen.getByRole('button', { name: '6 members of Shared Agent' })
    fireEvent.focus(trigger)
    const invite = screen.getByRole('button', { name: 'Invite' })
    fireEvent.pointerDown(invite)
    fireEvent.blur(trigger, { relatedTarget: null })
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(invite).toBeInTheDocument()
    fireEvent.click(invite)
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('counts the overflow circle toward the configurable limit', () => {
    const { rerender } = render(<SidebarMemberIndicator {...props} maxFaces={1} />)
    const trigger = screen.getByRole('button', { name: '6 members of Shared Agent' })
    expect(within(trigger).queryAllByRole('img', { hidden: true })).toHaveLength(0)
    expect(within(trigger).getByTestId('sidebar-members-count-shared-agent')).toHaveTextContent('6')
    fireEvent.click(trigger)
    rerender(<SidebarMemberIndicator {...props} maxFaces={4} />)
    expect(within(trigger).getAllByRole('img', { hidden: true })).toHaveLength(3)
    expect(within(trigger).getByTestId('sidebar-members-count-shared-agent')).toHaveTextContent('6')
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
    expect(screen.queryByTestId('sidebar-members-count-shared-agent')).toBeNull()
    roster(members.slice(0, 1))
    rerender(<SidebarMemberIndicator {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })
})
