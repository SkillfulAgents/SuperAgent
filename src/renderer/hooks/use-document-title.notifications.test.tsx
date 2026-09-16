// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession } from '@shared/lib/types/api'
import { SessionView } from '@renderer/components/layout/session-view'
import { applySessionActivityStatus } from '@renderer/lib/agent-cache'
import { useSessions } from './use-sessions'
import { useDocumentTitle } from './use-document-title'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn() }))

vi.mock('@renderer/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/api')>(),
  apiFetch: mocks.apiFetch,
  apiJson: mocks.apiJson,
}))

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({
    selectedAgentSlug: 'agent-one',
    view: { kind: 'session', id: 'session-1' },
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: <T,>(options: {
    select: (state: { matches: Array<{ params: object; fullPath: string }> }) => T
  }) => options.select({ matches: [{ params: {}, fullPath: '/agents/$slug/sessions/$sessionId' }] }),
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ isStreaming: false }),
}))
vi.mock('@renderer/context/pending-messages-context', () => ({
  usePendingMessages: () => ({ getPendingMessages: () => [] }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => true }),
}))
vi.mock('@renderer/lib/perf', () => ({ useRenderTracker: () => {} }))
vi.mock('@renderer/hooks/use-session-search', () => ({ useSessionSearch: () => ({}) }))
vi.mock('@renderer/components/messages/session-search-bar', () => ({ SessionSearchBar: () => null }))
vi.mock('@renderer/components/layout/session-chat-column', () => ({ SessionChatColumn: () => null }))
vi.mock('@renderer/context/file-preview-context', () => ({
  FilePreviewProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@renderer/context/workflow-context', () => ({
  WorkflowProvider: ({ children }: { children: ReactNode }) => children,
}))

function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

function SessionHarness() {
  useDocumentTitle()
  useSessions('agent-one')
  return <SessionView agentSlug="agent-one" sessionId="session-1" />
}

describe('session notification tab title', () => {
  const title = 'Launch Plan — Agent One'
  let queryClient: QueryClient
  let serverSession: ApiSession

  beforeEach(() => {
    vi.clearAllMocks()
    setTabHidden(false)
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 5000, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
    serverSession = {
      id: 'session-1',
      agentSlug: 'agent-one',
      name: 'Launch Plan',
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      messageCount: 1,
      hasUnreadNotifications: true,
    }
    const agent = { slug: 'agent-one', name: 'Agent One' }
    queryClient.setQueryData(['agents'], [agent])
    queryClient.setQueryData(['agents', 'agent-one'], agent)
    queryClient.setQueryData(['sessions', 'agent-one'], [serverSession])
    queryClient.setQueryData(['session', 'session-1', 'agent-one'], serverSession)

    mocks.apiJson.mockImplementation(async () => ({ ...serverSession }))
    mocks.apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/notifications/read-by-session/session-1' && options?.method === 'POST') {
        serverSession = { ...serverSession, hasUnreadNotifications: false }
        return { ok: true, json: async () => ({ success: true, count: 1 }) }
      }
      if (url === '/api/agents/agent-one/sessions/session-1/unread' && options?.method === 'DELETE') {
        return { ok: true, json: async () => ({ success: true, markedUnread: false, changed: false }) }
      }
      if (url === '/api/agents/agent-one/sessions') {
        return { ok: true, json: async () => [{ ...serverSession }] }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
  })

  function receiveNotification() {
    serverSession = { ...serverSession, hasUnreadNotifications: true }
    act(() => {
      applySessionActivityStatus(queryClient, 'agent-one', 'session-1', { hasUnreadNotifications: true })
    })
  }

  async function expectSessionListRead() {
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
      expect(queryClient.isFetching()).toBe(0)
      expect(queryClient.getQueryData<ApiSession[]>(['sessions', 'agent-one'])?.[0].hasUnreadNotifications)
        .toBe(false)
    })
  }

  it('keeps a viewed notification cleared across tab switches and shows the next notification', async () => {
    render(<QueryClientProvider client={queryClient}><SessionHarness /></QueryClientProvider>)
    await waitFor(() => expect(serverSession.hasUnreadNotifications).toBe(false))
    await expectSessionListRead()
    await waitFor(() => expect(document.title).toBe(title))

    act(() => setTabHidden(true))
    receiveNotification()
    await waitFor(() => expect(document.title).toBe(`● ${title}`))

    act(() => setTabHidden(false))
    await expectSessionListRead()
    expect(document.title).toBe(title)

    act(() => setTabHidden(true))
    await waitFor(() => expect(document.title).toBe(title))

    act(() => setTabHidden(false))
    await expectSessionListRead()
    act(() => setTabHidden(true))
    expect(document.title).toBe(title)

    receiveNotification()
    await waitFor(() => expect(document.title).toBe(`● ${title}`))
  })
})
