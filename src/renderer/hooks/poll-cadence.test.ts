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

import { useMessages } from './use-messages'
import { useChatIntegrationSessions } from './use-chat-integrations'

describe('polling cadence (reviewed interval constants)', () => {
  beforeEach(() => {
    capturedOptions.length = 0
  })

  it('useMessages polls every 15s as the SSE safety net', () => {
    renderHook(() => useMessages('session-1', 'agent-1'))
    expect(capturedOptions.at(-1)?.refetchInterval).toBe(15000)
  })

  it('useChatIntegrationSessions polls every 20s and not while backgrounded', () => {
    renderHook(() => useChatIntegrationSessions('integration-1'))
    const opts = capturedOptions.at(-1)
    expect(opts?.refetchInterval).toBe(20000)
    expect(opts?.refetchIntervalInBackground).toBe(false)
  })
})
