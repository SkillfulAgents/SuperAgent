// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// Capture the options object each hook hands to useQuery so we can pin the
// deliberately-chosen polling cadence. These intervals were lowered from their
// original values (messages 5s, chat sessions 10s) as a reviewed perf trade-off;
// this test makes an accidental revert or further drift fail loudly.
const capturedOptions: Record<string, unknown>[] = []

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: ((options: Record<string, unknown>) => {
      capturedOptions.push(options)
      return { data: undefined, isLoading: false, isError: false }
    }) as unknown as typeof actual.useQuery,
  }
})

import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMessages } from './use-messages'
import { useChatIntegrationSessions } from './use-chat-integrations'

// useMessages reads the query cache via useQueryClient (delta anchoring), so a
// real provider is needed even with useQuery itself mocked out.
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children)

describe('polling cadence (reviewed interval constants)', () => {
  beforeEach(() => {
    capturedOptions.length = 0
  })

  it('useMessages polls every 15s as the SSE safety net', () => {
    renderHook(() => useMessages('session-1', 'agent-1'), { wrapper })
    const messagesQuery = capturedOptions.find((opts) => {
      const key = opts.queryKey as unknown[] | undefined
      return Array.isArray(key) && key[0] === 'messages'
    })
    expect(messagesQuery?.refetchInterval).toBe(15000)
  })

  it('useChatIntegrationSessions polls every 20s and not while backgrounded', () => {
    renderHook(() => useChatIntegrationSessions('integration-1'))
    const opts = capturedOptions.at(-1)
    expect(opts?.refetchInterval).toBe(20000)
    expect(opts?.refetchIntervalInBackground).toBe(false)
  })
})
