// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderWithProviders, screen, userEvent } from '@renderer/test/test-utils'
import type { ApiNotification } from '@shared/lib/types/api'

// ---------------------------------------------------------------------------
// Mock state — mutated by tests, reset in beforeEach
// ---------------------------------------------------------------------------

const mockMarkReadMutate = vi.fn()
const mockMarkAllReadMutate = vi.fn()
const mockNavigate = vi.fn()

let mockNotificationsData: { items: ApiNotification[]; total: number } | undefined
let mockNotificationsLoading = false
let mockUnreadCount = 0
let mockAgents: { slug: string; name: string }[] = []
let mockMarkAllPending = false

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@renderer/hooks/use-notifications', () => ({
  useNotifications: () => ({
    data: mockNotificationsData,
    isLoading: mockNotificationsLoading,
  }),
  useUnreadNotificationCount: () => ({
    data: { count: mockUnreadCount },
  }),
  useMarkNotificationRead: () => ({
    mutate: mockMarkReadMutate,
  }),
  useMarkAllNotificationsRead: () => ({
    mutate: mockMarkAllReadMutate,
    isPending: mockMarkAllPending,
  }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: mockAgents }),
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getApiBaseUrl: () => 'http://localhost:3000',
}))

// The back button navigates via useNavigate. Capture the navigate target via a
// file-level useNavigate spy (overrides the global no-op stub). The notification
// ROWS navigate declaratively via <AppLink>, which the global stub renders as
// <a data-to/data-params>.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}))

import { NotificationsView } from './notifications-view'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<ApiNotification> & { id: string }): ApiNotification {
  return {
    type: 'session_complete',
    sessionId: `session-${overrides.id}`,
    agentSlug: 'agent-abc-123',
    title: `Notification ${overrides.id}`,
    body: `Body for ${overrides.id}`,
    isRead: false,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    readAt: null,
    ...overrides,
  }
}

function makeNotifications(count: number): ApiNotification[] {
  return Array.from({ length: count }, (_, i) =>
    makeNotification({ id: `n${i + 1}` }),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNotificationsData = undefined
    mockNotificationsLoading = false
    mockUnreadCount = 0
    mockAgents = []
    mockMarkAllPending = false
  })

  // -----------------------------------------------------------------------
  // Empty & loading states
  // -----------------------------------------------------------------------

  it('shows loading spinner while fetching', () => {
    mockNotificationsLoading = true
    renderWithProviders(<NotificationsView />)
    expect(screen.getByText('Loading notifications...')).toBeTruthy()
  })

  it('shows empty state when there are no notifications', () => {
    mockNotificationsData = { items: [], total: 0 }
    renderWithProviders(<NotificationsView />)
    expect(screen.getByText('No notifications yet.')).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // Rendering items
  // -----------------------------------------------------------------------

  it('renders notification rows with title and body', () => {
    mockNotificationsData = {
      items: [makeNotification({ id: '1', title: 'Task done', body: 'Agent finished' })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    expect(screen.getByText('Task done')).toBeTruthy()
    expect(screen.getByText('Agent finished')).toBeTruthy()
  })

  it('shows agent display name when available', () => {
    mockAgents = [{ slug: 'agent-abc-123', name: 'My Agent' }]
    mockNotificationsData = {
      items: [makeNotification({ id: '1' })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    expect(screen.getByText('My Agent')).toBeTruthy()
  })

  it('falls back to agentSlug when agent name is unavailable', () => {
    mockAgents = []
    mockNotificationsData = {
      items: [makeNotification({ id: '1', agentSlug: 'cool-bot-xyz' })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    expect(screen.getByText('cool-bot-xyz')).toBeTruthy()
  })

  it('shows unread indicator for unread notifications', () => {
    mockNotificationsData = {
      items: [makeNotification({ id: '1', isRead: false })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    expect(screen.getByLabelText('Unread')).toBeTruthy()
  })

  it('does not show unread indicator for read notifications', () => {
    mockNotificationsData = {
      items: [makeNotification({ id: '1', isRead: true })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    expect(screen.queryByLabelText('Unread')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Click behavior
  // -----------------------------------------------------------------------

  it('links a notification to its session route', () => {
    mockNotificationsData = {
      items: [makeNotification({ id: '1', agentSlug: 'bot-1', sessionId: 'sess-42' })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    const link = screen.getByText('Notification 1').closest('a')
    expect(link).toHaveAttribute('data-to', '/agents/$slug/sessions/$sessionId')
    expect(link).toHaveAttribute('data-params', JSON.stringify({ slug: 'bot-1', sessionId: 'sess-42' }))
  })

  it('marks unread notification as read on click', async () => {
    const user = userEvent.setup()
    mockNotificationsData = {
      items: [makeNotification({ id: 'n1', isRead: false })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    await user.click(screen.getByText('Notification n1'))
    expect(mockMarkReadMutate).toHaveBeenCalledWith('n1')
  })

  it('does not call markRead for already-read notifications', async () => {
    const user = userEvent.setup()
    mockNotificationsData = {
      items: [makeNotification({ id: 'n1', isRead: true })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    await user.click(screen.getByText('Notification n1'))
    expect(mockMarkReadMutate).not.toHaveBeenCalled()
  })

  it('links a chat-integration notification to the agent home', () => {
    mockNotificationsData = {
      items: [makeNotification({
        id: 'ci1',
        type: 'session_chat_integration',
        agentSlug: 'slack-bot-1',
        title: 'Chat Integration Connected',
      })],
      total: 1,
    }
    renderWithProviders(<NotificationsView />)
    const link = screen.getByText('Chat Integration Connected').closest('a')
    expect(link).toHaveAttribute('data-to', '/agents/$slug')
    expect(link).toHaveAttribute('data-params', JSON.stringify({ slug: 'slack-bot-1' }))
  })

  // -----------------------------------------------------------------------
  // Mark all as read
  // -----------------------------------------------------------------------

  it('calls markAllRead when the button is clicked', async () => {
    const user = userEvent.setup()
    mockUnreadCount = 5
    mockNotificationsData = { items: [makeNotification({ id: '1' })], total: 1 }
    renderWithProviders(<NotificationsView />)
    await user.click(screen.getByTestId('notifications-mark-all-read'))
    expect(mockMarkAllReadMutate).toHaveBeenCalled()
  })

  it('disables mark-all-read button when there are no unread notifications', () => {
    mockUnreadCount = 0
    mockNotificationsData = { items: [makeNotification({ id: '1', isRead: true })], total: 1 }
    renderWithProviders(<NotificationsView />)
    const button = screen.getByTestId('notifications-mark-all-read')
    expect(button).toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------

  it('does not show pagination when total fits in one page', () => {
    mockNotificationsData = { items: makeNotifications(5), total: 5 }
    renderWithProviders(<NotificationsView />)
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull()
  })

  it('shows pagination controls when total exceeds page size', () => {
    mockNotificationsData = { items: makeNotifications(15), total: 30 }
    renderWithProviders(<NotificationsView />)
    expect(screen.getByText('1 / 2')).toBeTruthy()
    expect(screen.getByText('30 total')).toBeTruthy()
  })

  it('disables previous button on first page', () => {
    mockNotificationsData = { items: makeNotifications(15), total: 30 }
    renderWithProviders(<NotificationsView />)
    const prevButton = screen.getAllByRole('button').find((b) =>
      b.querySelector('.lucide-chevron-left'),
    )
    expect(prevButton).toBeDefined()
    expect(prevButton!).toBeDisabled()
  })

  it('navigates to the next page when the next button is clicked', async () => {
    const user = userEvent.setup()
    mockNotificationsData = { items: makeNotifications(15), total: 30 }
    renderWithProviders(<NotificationsView />)
    const nextButton = screen.getAllByRole('button').find((b) =>
      b.querySelector('.lucide-chevron-right'),
    )
    expect(nextButton).toBeDefined()
    await user.click(nextButton!)
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // Back button
  // -----------------------------------------------------------------------

  it('navigates home when the back button is clicked', async () => {
    const user = userEvent.setup()
    mockNotificationsData = { items: [], total: 0 }
    renderWithProviders(<NotificationsView />)
    await user.click(screen.getByTestId('notifications-back-button'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
  })

  // -----------------------------------------------------------------------
  // Date formatting
  // -----------------------------------------------------------------------

  describe('date formatting', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-20T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('formats yesterday timestamps as "yesterday"', () => {
      mockNotificationsData = {
        items: [makeNotification({ id: '1', createdAt: new Date('2026-05-19T10:00:00Z') })],
        total: 1,
      }
      renderWithProviders(<NotificationsView />)
      expect(screen.getByText('yesterday')).toBeTruthy()
    })

    it('formats same-year timestamps as month + day', () => {
      mockNotificationsData = {
        items: [makeNotification({ id: '1', createdAt: new Date('2026-03-15T10:00:00Z') })],
        total: 1,
      }
      renderWithProviders(<NotificationsView />)
      expect(screen.getByText('mar 15')).toBeTruthy()
    })

    it('formats prior-year timestamps with year', () => {
      mockNotificationsData = {
        items: [makeNotification({ id: '1', createdAt: new Date('2025-12-01T10:00:00Z') })],
        total: 1,
      }
      renderWithProviders(<NotificationsView />)
      expect(screen.getByText('dec 1, 2025')).toBeTruthy()
    })
  })
})
