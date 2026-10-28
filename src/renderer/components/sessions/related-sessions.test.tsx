// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RelatedSessions, type SessionItem } from './related-sessions'

vi.mock('@renderer/router/use-route-location', () => ({ useRouteLocation: () => ({}) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('./session-context-menu', () => ({ SessionContextMenu: ({ children }: { children: unknown }) => children }))

afterEach(cleanup)

const sessions: SessionItem[] = Array.from({ length: 11 }, (_, i) => ({
  id: `${i + 1}`, name: `Chat ${i + 1}`, createdAt: new Date(Date.UTC(2026, 9, 27, 12 - i)).toISOString(),
}))
const formatDate = (date: string) => date
const rows = () => screen.queryAllByText(/^(Chat|Waiting) /).map((row) => row.textContent)

describe('RelatedSessions', () => {
  it('sorts before capping the preview and keeps waiting first when expanded', () => {
    const all = [...sessions, { id: 'waiting', name: 'Waiting run', createdAt: '2026-10-01', isAwaitingInput: true }]
    const { rerender } = render(<RelatedSessions sessions={all} formatDate={formatDate} awaitingFirst limit={3} pageSize={3} />)
    expect(rows()).toEqual(['Waiting run', 'Chat 1', 'Chat 2'])
    expect(screen.queryByText(/^Page /)).toBeNull()
    rerender(<RelatedSessions sessions={all} formatDate={formatDate} awaitingFirst pageSize={5} />)
    expect(rows()).toEqual(['Waiting run', 'Chat 1', 'Chat 2', 'Chat 3', 'Chat 4'])
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
  })

  it('clamps the page when the last page is removed and resets on a page-size change', async () => {
    const { rerender } = render(<RelatedSessions sessions={sessions} formatDate={formatDate} pageSize={5} />)
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(rows()).toEqual(['Chat 11'])
    rerender(<RelatedSessions sessions={sessions.slice(0, 10)} formatDate={formatDate} pageSize={5} />)
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    expect(rows()).toEqual(['Chat 6', 'Chat 7', 'Chat 8', 'Chat 9', 'Chat 10'])
    rerender(<RelatedSessions sessions={sessions} formatDate={formatDate} pageSize={3} limit={3} />)
    expect(rows()).toEqual(['Chat 1', 'Chat 2', 'Chat 3'])
    expect(screen.queryByText(/^Page /)).toBeNull()
  })

  it('resets on external search or sort changes while retaining normal activity order by default', async () => {
    const all = sessions.map((session, index) => ({ ...session, isAwaitingInput: index === 10 }))
    const { rerender } = render(<RelatedSessions sessions={all} formatDate={formatDate} pageSize={5} />)
    expect(rows()).toEqual(['Chat 1', 'Chat 2', 'Chat 3', 'Chat 4', 'Chat 5'])
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    rerender(<RelatedSessions sessions={all} formatDate={formatDate} pageSize={5} sortOrder="oldest" />)
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(rows()[0]).toBe('Chat 11')
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    rerender(<RelatedSessions sessions={all} formatDate={formatDate} pageSize={5} searchQuery="Chat 1" />)
    // Search highlights split the name into spans; assert the accessible row names.
    expect(screen.getAllByRole('button', { name: /Chat / })).toHaveLength(3)
    expect(screen.queryByText(/^Page /)).toBeNull()
  })
})
