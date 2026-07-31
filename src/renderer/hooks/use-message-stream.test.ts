// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Create a mock EventSource class
class MockEventSource {
  static instances: MockEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

  url: string
  readyState = MockEventSource.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  close() {
    this.readyState = MockEventSource.CLOSED
  }

  // Helper to simulate receiving an SSE message
  simulateMessage(data: Record<string, unknown>) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) })
    }
  }

  // Helper to simulate an error
  simulateError() {
    if (this.onerror) {
      this.onerror()
    }
  }
}

// Mock the environment
vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => '',
}))

// Set up global EventSource before importing the hook
const originalEventSource = globalThis.EventSource
beforeEach(() => {
  MockEventSource.instances = []
  ;(globalThis as any).EventSource = MockEventSource
  // Mock global fetch for browser status check
  globalThis.fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ active: false }),
  }) as any
})

afterEach(() => {
  ;(globalThis as any).EventSource = originalEventSource
  vi.restoreAllMocks()
})

// Must import AFTER setting up mocks
// Use dynamic import to get fresh module state per test
async function getHookModule() {
  // Clear module cache to get fresh global state
  vi.resetModules()
  const mod = await import('./use-message-stream')
  return mod
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return Object.assign(wrapper, { queryClient })
}

describe('useMessageStream', () => {
  it('returns default state initially', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    expect(result.current.isActive).toBe(false)
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.streamingMessage).toBeNull()
    expect(result.current.streamingToolUses).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('creates EventSource for session', async () => {
    const { useMessageStream } = await getHookModule()
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toBe('/api/agents/agent-1/sessions/session-1/stream')
  })

  it('shares ONE EventSource when the same session is subscribed with different agent-slug forms', async () => {
    // The sidebar subscribes with the canonical agent id while the session view
    // uses the URL display slug — both for the same session. Keying the singleton
    // by sessionId keeps it to one connection; otherwise both streams write the
    // same session state and the assistant response renders doubled.
    const { useMessageStream } = await getHookModule()
    renderHook(
      () => {
        useMessageStream('session-1', 'greeting-assistant-abcd123456') // session view: display slug
        useMessageStream('session-1', 'abcd123456') // sidebar: canonical id
      },
      { wrapper: createWrapper() }
    )

    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('handles connected event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected',
        isActive: false,
      })
    })

    expect(result.current.isActive).toBe(false)
    expect(result.current.isStreaming).toBe(false)
  })

  it('tracks autopilot review progress and resyncs it from the connected snapshot', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: false })
    })
    expect(result.current.autopilotReviewing).toBe(false)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'autopilot_review', status: 'started' })
    })
    expect(result.current.autopilotReviewing).toBe(true)

    // A reconnect that missed the one-shot `finished` broadcast must not show
    // "Reviewing progress…" forever — the snapshot is the truth.
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: false })
    })
    expect(result.current.autopilotReviewing).toBe(false)

    // And a client connecting DURING a live review picks it up from the snapshot.
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected',
        isActive: false,
        autopilotReviewing: true,
      })
    })
    expect(result.current.autopilotReviewing).toBe(true)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'autopilot_review', status: 'finished' })
    })
    expect(result.current.autopilotReviewing).toBe(false)
  })

  it('handles session_active event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected',
        isActive: false,
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'session_active',
      })
    })

    expect(result.current.isActive).toBe(true)
    expect(result.current.activeStartTime).not.toBeNull()
  })

  it('handles streaming: stream_start → stream_delta → stream_end', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })
    expect(result.current.isStreaming).toBe(true)
    expect(result.current.streamingMessage).toBe('')

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'Hello ' })
    })
    expect(result.current.streamingMessage).toBe('Hello ')

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'world!' })
    })
    expect(result.current.streamingMessage).toBe('Hello world!')

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_end' })
    })
    expect(result.current.isStreaming).toBe(false)
    // streamingMessage is preserved until persisted data arrives
    expect(result.current.streamingMessage).toBe('Hello world!')
  })

  it('handles session_idle event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: false })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })
    expect(result.current.isActive).toBe(true)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
    })
    expect(result.current.isActive).toBe(false)
    expect(result.current.isStreaming).toBe(false)
  })

  it('handles session_error event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'session_error',
        error: 'Rate limit exceeded',
      })
    })

    expect(result.current.isActive).toBe(false)
    expect(result.current.error).toBe('Rate limit exceeded')
    expect(result.current.apiErrorCode).toBeNull()
  })

  it('parses apiErrorCode from session_error event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'session_error',
        error: 'Invalid API key',
        apiErrorCode: 'authentication_failed',
      })
    })

    expect(result.current.error).toBe('Invalid API key')
    expect(result.current.apiErrorCode).toBe('authentication_failed')
  })

  it('sets apiErrorCode from stream_api_error event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'Rate limited' })
    })
    expect(result.current.apiErrorCode).toBeNull()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_api_error', apiErrorCode: 'rate_limit' })
    })
    expect(result.current.apiErrorCode).toBe('rate_limit')
    expect(result.current.streamingMessage).toBe('Rate limited')
  })

  it('sets apiErrorCode from stream_delta event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'stream_delta',
        text: 'Invalid API key',
        apiErrorCode: 'authentication_failed',
      })
    })
    expect(result.current.apiErrorCode).toBe('authentication_failed')
    expect(result.current.streamingMessage).toBe('Invalid API key')
  })

  it('preserves apiErrorCode through session_idle', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'stream_delta',
        text: 'Error text',
        apiErrorCode: 'authentication_failed',
      })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle', isActive: false })
    })
    expect(result.current.apiErrorCode).toBe('authentication_failed')
  })

  it('handles tool_use_start and tool_use_streaming events', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_start',
        toolId: 'tc-1',
        toolName: 'Bash',
        partialInput: '',
      })
    })

    expect(result.current.streamingToolUses).toEqual([{
      id: 'tc-1',
      name: 'Bash',
      partialInput: '',
    }])

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_streaming',
        toolId: 'tc-1',
        toolName: 'Bash',
        partialInput: '{"command": "ls"}',
      })
    })

    expect(result.current.streamingToolUses[0]?.partialInput).toBe('{"command": "ls"}')
  })

  it('handles compact_start and compact_complete events', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'compact_start' })
    })
    expect(result.current.isCompacting).toBe(true)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'compact_complete' })
    })
    expect(result.current.isCompacting).toBe(false)
  })

  it('handles error recovery — resets streaming but preserves isActive', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'Hello' })
    })

    // Simulate error
    act(() => {
      MockEventSource.instances[0].simulateError()
    })

    // isActive should be preserved, streaming should be reset
    expect(result.current.isActive).toBe(true)
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.streamingMessage).toBeNull()
  })

  it('handles subagent streaming events', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-agent-1',
      })
    })

    expect(result.current.activeSubagents).toContainEqual({
      parentToolId: 'pt-1',
      agentId: 'sub-agent-1',
      streamingMessage: '',
      streamingToolUse: null,
      progressSummary: null,
      subagentType: null,
      description: null,
      usage: null,
      lastToolName: null,
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_delta',
        parentToolId: 'pt-1',
        text: 'Sub content',
      })
    })

    expect(result.current.activeSubagents.find(s => s.parentToolId === 'pt-1')?.streamingMessage).toBe('Sub content')
  })

  it('handles ping safety net sync', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })
    expect(result.current.isActive).toBe(true)

    // Ping says inactive → should sync
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'ping', isActive: false })
    })
    expect(result.current.isActive).toBe(false)
  })

  it('returns null state when sessionId is null', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream(null, null),
      { wrapper: createWrapper() }
    )

    expect(result.current.isActive).toBe(false)
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('handles slash commands from connected event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected',
        isActive: false,
        slashCommands: [
          { name: 'deploy', description: 'Deploy app', argumentHint: '<env>' },
        ],
      })
    })

    expect(result.current.slashCommands).toHaveLength(1)
    expect(result.current.slashCommands[0].name).toBe('deploy')
  })

  it('handles context_usage event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'context_usage',
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
        contextWindow: 200000,
      })
    })

    expect(result.current.contextUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200,
      contextWindow: 200000,
    })
  })

  // ---- Additional request event types ----

  // ---- Query invalidation ----

  it('invalidates sessions query on session_active', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: false })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  it('invalidates messages and sessions queries on session_idle', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  // The session_idle SSE can arrive before the final assistant line is durably
  // readable in the JSONL transcript, so the handler's immediate invalidate may
  // refetch stale data. A bounded reconcile loop refetches a few more times until
  // the persisted tail matches the streamed text, so finalization (the "Worked
  // for Xs" line) doesn't wait for the slow safety-net poll.
  const countMessageInvalidations = (spy: ReturnType<typeof vi.spyOn>): number =>
    spy.mock.calls.filter((call: unknown[]) => {
      const key = (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey
      return Array.isArray(key) && key[0] === 'messages' && key[1] === 'session-1'
    }).length

  it('reconciles messages after session_idle when the transcript lags, then stops', async () => {
    vi.useFakeTimers()
    try {
      const { useMessageStream } = await getHookModule()
      const wrapper = createWrapper()
      const qc = wrapper.queryClient
      const spy = vi.spyOn(qc, 'invalidateQueries')
      renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper })

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })
      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
      })
      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'Final answer' })
      })

      // Persisted transcript does NOT yet contain the final assistant line.
      qc.setQueryData(['messages', 'session-1', 'agent-1'], [
        { id: 'u1', type: 'user', content: { text: 'hi' }, createdAt: '2026-01-01T00:00:00Z' },
      ])

      spy.mockClear()
      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
      })
      // Immediate invalidate from the handler.
      expect(countMessageInvalidations(spy)).toBe(1)

      // First backoff tick: still no match → an extra refetch fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(countMessageInvalidations(spy)).toBeGreaterThan(1)

      // Drain well past the reconcile window — it must self-terminate (bounded:
      // 1 immediate + at most 3 reconcile attempts).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(countMessageInvalidations(spy)).toBeLessThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reconcile after session_idle when the persisted message already matches', async () => {
    vi.useFakeTimers()
    try {
      const { useMessageStream } = await getHookModule()
      const wrapper = createWrapper()
      const qc = wrapper.queryClient
      const spy = vi.spyOn(qc, 'invalidateQueries')
      renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper })

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })
      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'Final answer' })
      })

      // Transcript already has the final assistant line (no write/read race).
      qc.setQueryData(['messages', 'session-1', 'agent-1'], [
        { id: 'u1', type: 'user', content: { text: 'hi' }, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'a1', type: 'assistant', content: { text: 'Final answer' }, toolCalls: [], createdAt: '2026-01-01T00:00:01Z' },
      ])

      spy.mockClear()
      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
      })

      // Only the handler's immediate invalidate — the reconcile sees a match and bails.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(countMessageInvalidations(spy)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates messages and sessions queries on session_error', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_error', error: 'boom' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  it('invalidates messages on compact_complete', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'compact_complete' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
  })

  it('invalidates messages on messages_updated event', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'messages_updated' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
  })

  it('invalidates messages on tool_call event and stops streaming', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })
    expect(result.current.isStreaming).toBe(true)
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'tool_call' })
    })

    expect(result.current.isStreaming).toBe(false)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
  })

  it('invalidates messages on tool_result event', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'tool_result' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
  })

  it('invalidates messages on error (EventSource onerror)', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateError()
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
  })

  // ---- Additional event types ----

  it('handles browser_active event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'browser_active', active: true })
    })
    expect(result.current.browserActive).toBe(true)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'browser_active', active: false })
    })
    expect(result.current.browserActive).toBe(false)
  })

  it('handles session_updated event — invalidates session queries', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_updated' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['session', 'session-1'] })
  })

  it('handles scheduled_task_created event — invalidates scheduled tasks', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'scheduled_task_created', agentSlug: 'agent-1' })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['scheduled-tasks', 'agent-1'] })
  })

  it('handles tool_use_ready event — preserves streaming tool use', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_start',
        toolId: 'tc-1',
        toolName: 'Bash',
        partialInput: '{"cmd":"ls"}',
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'tool_use_ready', toolId: 'tc-1' })
    })

    // Tool use should still be visible, now marked as ready
    expect(result.current.streamingToolUses).toEqual([{
      id: 'tc-1',
      name: 'Bash',
      partialInput: '{"cmd":"ls"}',
      ready: true,
    }])
    expect(result.current.isStreaming).toBe(true)
  })

  it('invalidates status queries when a blocking user-input tool becomes ready', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_start',
        toolId: 'tc-1',
        toolName: 'mcp__user-input__request_secret',
        partialInput: '{"secretName":"OPENAI_API_KEY"}',
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_ready',
        toolId: 'tc-1',
        toolName: 'mcp__user-input__request_secret',
      })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agents'] })
  })

  it('does not invalidate status queries when a script-run tool becomes ready', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_start',
        toolId: 'tc-1',
        toolName: 'mcp__user-input__request_script_run',
        partialInput: '{"script":"echo ok"}',
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_ready',
        toolId: 'tc-1',
        toolName: 'mcp__user-input__request_script_run',
      })
    })

    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['sessions'] })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['agents'] })
  })

  // ---- Subagent lifecycle ----

  it('handles subagent_completed — keeps streaming data and marks as completed', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })

    // Add streaming content (e.g., summary text)
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_delta',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
        text: 'summary text',
      })
    })
    expect(result.current.activeSubagents).toHaveLength(1)
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'subagent_completed', parentToolId: 'pt-1' })
    })

    // Streaming data preserved so summary stays visible until persisted data arrives
    expect(result.current.activeSubagents).toHaveLength(1)
    const sub = result.current.activeSubagents[0]
    expect(sub?.streamingMessage).toBe('summary text')
    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['subagent-messages', 'session-1'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
  })

  it('handles subagent_updated — clears streaming state and invalidates subagent messages', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_delta',
        parentToolId: 'pt-1',
        text: 'working...',
      })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_updated',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })

    // Streaming state preserved (SubAgentBlock dedup handles transition), subagent still active
    const sub = result.current.activeSubagents.find(s => s.parentToolId === 'pt-1')
    expect(sub?.streamingMessage).toBe('working...')
    expect(sub?.streamingToolUse).toBeNull()
    expect(sub?.parentToolId).toBe('pt-1')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['subagent-messages', 'session-1'] })
  })

  it('handles subagent_tool_use_start and subagent_tool_use_streaming', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_tool_use_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
        toolId: 'sub-tc-1',
        toolName: 'Read',
        partialInput: '',
      })
    })

    expect(result.current.activeSubagents.find(s => s.parentToolId === 'pt-1')?.streamingToolUse).toEqual({
      id: 'sub-tc-1',
      name: 'Read',
      partialInput: '',
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_tool_use_streaming',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
        toolId: 'sub-tc-1',
        toolName: 'Read',
        partialInput: '{"file": "config.ts"}',
      })
    })

    const sub = result.current.activeSubagents.find(s => s.parentToolId === 'pt-1')
    expect(sub?.streamingToolUse?.partialInput).toBe('{"file": "config.ts"}')
    // streamingMessage should be preserved
    expect(sub?.streamingMessage).toBe('')
  })

  // ---- Remove helpers ----

  it('handles clearCompacting helper', async () => {
    const { useMessageStream, clearCompacting } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'compact_start' })
    })
    expect(result.current.isCompacting).toBe(true)

    act(() => {
      clearCompacting('session-1')
    })

    expect(result.current.isCompacting).toBe(false)
  })

  it('handles clearBrowserActive helper', async () => {
    const { useMessageStream, clearBrowserActive } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'browser_active', active: true })
    })
    expect(result.current.browserActive).toBe(true)

    act(() => {
      clearBrowserActive('session-1')
    })

    expect(result.current.browserActive).toBe(false)
  })

  // ---- State transition edge cases ----

  it('session_active clears previous error', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_error', error: 'Rate limit' })
    })
    expect(result.current.error).toBe('Rate limit')

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })
    expect(result.current.error).toBeNull()
    expect(result.current.isActive).toBe(true)
  })

  it('session_idle preserves streamingMessage for deduplication', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_delta', text: 'Preserved text' })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_end' })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
    })

    // streamingMessage preserved so MessageList can deduplicate
    expect(result.current.streamingMessage).toBe('Preserved text')
    expect(result.current.streamingToolUses).toEqual([])
  })

  it('stream_start invalidates messages when previous streamingToolUses exist', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_start',
        toolId: 'tc-1',
        toolName: 'Bash',
        partialInput: '',
      })
    })
    expect(result.current.streamingToolUses.length).toBeGreaterThan(0)
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })

    // Should invalidate messages to fetch persisted tool call before clearing streaming state
    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
    expect(result.current.streamingToolUses).toEqual([])
  })

  it('ping does not change state when server agrees session is active', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'ping', isActive: true })
    })

    expect(result.current.isActive).toBe(true)
  })

  it('connected event fetches browser status', async () => {
    await getHookModule()
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>

    const { useMessageStream } = await getHookModule()
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: false })
    })

    expect(fetchSpy).toHaveBeenCalledWith('/api/agents/agent-1/browser/status')
  })

  it('session_active clears activeSubagents', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })
    expect(result.current.activeSubagents).toHaveLength(1)

    // New session_active should clear subagents
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })
    expect(result.current.activeSubagents).toHaveLength(0)
    expect(result.current.completedSubagents).toBeNull()
  })

  it('session_active clears completedSubagents', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'subagent_completed', parentToolId: 'pt-1' })
    })
    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)

    // New session_active should clear completedSubagents
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })
    expect(result.current.completedSubagents).toBeNull()
  })

  it('completedSubagents survives session_idle', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'subagent_completed', parentToolId: 'pt-1' })
    })
    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)

    // session_idle should preserve completedSubagents
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
    })
    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)
  })

  it('tracks multiple subagent completions independently', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    // Start two subagents
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-2',
        agentId: 'sub-2',
      })
    })
    expect(result.current.activeSubagents).toHaveLength(2)

    // Complete only the first
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'subagent_completed', parentToolId: 'pt-1' })
    })
    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)
    expect(result.current.completedSubagents?.has('pt-2')).toBeFalsy()
    // Both still in activeSubagents (streaming data preserved)
    expect(result.current.activeSubagents).toHaveLength(2)

    // Complete the second
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'subagent_completed', parentToolId: 'pt-2' })
    })
    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)
    expect(result.current.completedSubagents?.has('pt-2')).toBe(true)
  })

  it('ping invalidates messages and sessions when correcting active state', async () => {
    const { useMessageStream } = await getHookModule()
    const wrapper = createWrapper()
    const spy = vi.spyOn(wrapper.queryClient, 'invalidateQueries')
    renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'ping', isActive: false })
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  describe('auto-approved suppress-sets (from user_request_created)', () => {
    it('an auto-approved script_run enters the suppress-set', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-auto-1', 'agent-1'),
        { wrapper }
      )

      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })
      const es = MockEventSource.instances[MockEventSource.instances.length - 1]

      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })

      act(() => {
        es.simulateMessage({
          type: 'user_request_created',
          agentSlug: 'agent-1',
          request: {
            id: 'tool-auto',
            kind: 'script_run',
            scope: { agentSlug: 'agent-1', sessionId: 'session-auto-1' },
            blocking: true,
            autoApproved: true,
            payload: { script: 'sw_vers', explanation: 'Check version', scriptType: 'shell' },
          },
        })
      })

      await vi.waitFor(() => {
        expect(result.current.autoApprovedScriptRunIds.has('tool-auto')).toBe(true)
      })

    })

    it('default autoApprovedScriptRunIds is empty for a fresh session', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-auto-empty', 'agent-1'),
        { wrapper }
      )

      expect(result.current.autoApprovedScriptRunIds.size).toBe(0)
    })

    it('an auto-approved computer_use enters its own suppress-set', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-auto-cu-1', 'agent-1'),
        { wrapper }
      )

      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })
      const es = MockEventSource.instances[MockEventSource.instances.length - 1]

      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })

      act(() => {
        es.simulateMessage({
          type: 'user_request_created',
          agentSlug: 'agent-1',
          request: {
            id: 'tool-cu-auto',
            kind: 'computer_use',
            scope: { agentSlug: 'agent-1', sessionId: 'session-auto-cu-1' },
            blocking: true,
            autoApproved: true,
            payload: { method: 'apps', params: {}, permissionLevel: 'list_apps_windows' },
          },
        })
      })

      await vi.waitFor(() => {
        expect(result.current.autoApprovedComputerUseIds.has('tool-cu-auto')).toBe(true)
      })

    })

    it('default autoApprovedComputerUseIds is empty for a fresh session', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-auto-cu-empty', 'agent-1'),
        { wrapper }
      )

      expect(result.current.autoApprovedComputerUseIds.size).toBe(0)
    })

    it('only autoApproved requests enter the suppress-set; prompt-form events feed nothing', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-auto-mixed', 'agent-1'),
        { wrapper }
      )

      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })
      const es = MockEventSource.instances[MockEventSource.instances.length - 1]

      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })

      // First request: needs prompt — its approval card comes from the
      // unified store, so nothing may suppress it.
      act(() => {
        es.simulateMessage({
          type: 'user_request_created',
          agentSlug: 'agent-1',
          request: {
            id: 'tool-prompt',
            kind: 'script_run',
            scope: { agentSlug: 'agent-1', sessionId: 'session-auto-mixed' },
            blocking: true,
            autoApproved: false,
            payload: { script: 'echo hi', explanation: 'Say hi', scriptType: 'shell' },
          },
        })
      })

      // Second request: auto-approved.
      act(() => {
        es.simulateMessage({
          type: 'user_request_created',
          agentSlug: 'agent-1',
          request: {
            id: 'tool-auto',
            kind: 'script_run',
            scope: { agentSlug: 'agent-1', sessionId: 'session-auto-mixed' },
            blocking: true,
            autoApproved: true,
            payload: { script: 'sw_vers', explanation: 'Check version', scriptType: 'shell' },
          },
        })
      })

      await vi.waitFor(() => {
        expect(result.current.autoApprovedScriptRunIds.has('tool-auto')).toBe(true)
      })

      expect(result.current.autoApprovedScriptRunIds.has('tool-prompt')).toBe(false)
    })
  })

  // ---- Peer user messages (shared sessions / message queueing) ----

  describe('peer user messages', () => {
    async function setupHook(sessionId: string) {
      const mod = await getHookModule()
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => mod.useMessageStream(sessionId, 'agent-1'),
        { wrapper }
      )
      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })
      const es = MockEventSource.instances[MockEventSource.instances.length - 1]
      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })
      return { mod, result, es }
    }

    it('appends peer messages with uuid, sender, and queued flag', async () => {
      const { result, es } = await setupHook('peer-s1')

      act(() => {
        es.simulateMessage({
          type: 'user_message',
          uuid: 'peer-uuid-1',
          content: 'Hello from Alice',
          sender: { id: 'u2', name: 'Alice' },
          queued: true,
        })
      })

      expect(result.current.peerUserMessages).toEqual([
        { uuid: 'peer-uuid-1', content: 'Hello from Alice', sender: { id: 'u2', name: 'Alice' }, queued: true, receivedAt: expect.any(Number) },
      ])
    })

    it('accumulates multiple peer messages and dedupes by uuid', async () => {
      const { result, es } = await setupHook('peer-s2')

      act(() => {
        es.simulateMessage({ type: 'user_message', uuid: 'p1', content: 'first', sender: { id: 'u2' } })
        es.simulateMessage({ type: 'user_message', uuid: 'p2', content: 'second', sender: { id: 'u2' }, queued: true })
        // Duplicate broadcast of p1 (e.g. SSE redelivery) must not double up
        es.simulateMessage({ type: 'user_message', uuid: 'p1', content: 'first', sender: { id: 'u2' } })
      })

      expect(result.current.peerUserMessages.map((p) => p.uuid)).toEqual(['p1', 'p2'])
    })

    it('ignores user_message events without a uuid', async () => {
      const { result, es } = await setupHook('peer-s3')

      act(() => {
        es.simulateMessage({ type: 'user_message', content: 'legacy broadcast', sender: { id: 'u2' } })
      })

      expect(result.current.peerUserMessages).toEqual([])
    })

    it('clears the typing indicator when the peer message arrives', async () => {
      const { result, es } = await setupHook('peer-s4')

      act(() => {
        es.simulateMessage({ type: 'user_typing', sender: { id: 'u2', name: 'Alice' } })
      })
      expect(result.current.typingUser).toEqual({ id: 'u2', name: 'Alice' })

      act(() => {
        es.simulateMessage({ type: 'user_message', uuid: 'p1', content: 'done typing', sender: { id: 'u2', name: 'Alice' } })
      })
      expect(result.current.typingUser).toBeNull()
    })

    it('preserves peer messages across unrelated stream events', async () => {
      const { result, es } = await setupHook('peer-s5')

      act(() => {
        es.simulateMessage({ type: 'user_message', uuid: 'p1', content: 'sticky', sender: { id: 'u2' }, queued: true })
        es.simulateMessage({ type: 'stream_start' })
        es.simulateMessage({ type: 'stream_delta', text: 'agent output' })
        es.simulateMessage({ type: 'session_active' })
      })

      expect(result.current.peerUserMessages.map((p) => p.uuid)).toEqual(['p1'])
    })

    it('removePeerUserMessage removes only the matching entry', async () => {
      const { mod, result, es } = await setupHook('peer-s6')

      act(() => {
        es.simulateMessage({ type: 'user_message', uuid: 'p1', content: 'first', sender: { id: 'u2' } })
        es.simulateMessage({ type: 'user_message', uuid: 'p2', content: 'second', sender: { id: 'u2' } })
      })

      act(() => {
        mod.removePeerUserMessage('peer-s6', 'p1')
      })
      expect(result.current.peerUserMessages.map((p) => p.uuid)).toEqual(['p2'])

      // Removing an unknown uuid is a no-op
      act(() => {
        mod.removePeerUserMessage('peer-s6', 'does-not-exist')
      })
      expect(result.current.peerUserMessages.map((p) => p.uuid)).toEqual(['p2'])
    })

    it('clearPeerUserMessages drops all entries', async () => {
      const { mod, result, es } = await setupHook('peer-s7')

      act(() => {
        es.simulateMessage({ type: 'user_message', uuid: 'p1', content: 'first', sender: { id: 'u2' } })
        es.simulateMessage({ type: 'user_message', uuid: 'p2', content: 'second', sender: { id: 'u2' }, queued: true })
      })

      act(() => {
        mod.clearPeerUserMessages('peer-s7')
      })
      expect(result.current.peerUserMessages).toEqual([])
    })
  })

  describe('command lifecycle', () => {
    async function setupHook(sessionId: string) {
      const mod = await getHookModule()
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => mod.useMessageStream(sessionId, 'agent-1'),
        { wrapper }
      )
      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })
      const es = MockEventSource.instances[MockEventSource.instances.length - 1]
      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })
      return { mod, result, es, queryClient: wrapper.queryClient }
    }

    it('accumulates terminal-dead command uuids (discarded/cancelled), deduped', async () => {
      const { result, es } = await setupHook('cmd-s1')

      act(() => {
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'discarded' })
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u2', state: 'cancelled' })
        // Redelivery must not double up
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'discarded' })
      })

      expect(result.current.discardedCommandUuids).toEqual(['u1', 'u2'])
    })

    it('does not treat non-terminal states or malformed frames as discarded', async () => {
      const { result, es } = await setupHook('cmd-s2')

      act(() => {
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'queued' })
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'started' })
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'completed' })
        es.simulateMessage({ type: 'command_lifecycle', state: 'discarded' })
      })

      expect(result.current.discardedCommandUuids).toEqual([])
    })

    it('refetches at queued-command pickup and again when its model response starts', async () => {
      const { es, queryClient } = await setupHook('cmd-s4')
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

      act(() => {
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'started' })
      })

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['messages', 'cmd-s4'] })

      // The pickup refetch can race the CLI's queued_command transcript write.
      // A model response proves the command has been incorporated, so it must
      // trigger one bounded reconciliation retry.
      invalidateSpy.mockClear()
      act(() => {
        es.simulateMessage({ type: 'stream_start' })
      })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['messages', 'cmd-s4'] })

      // The marker is consumed: later model iterations do not keep polling.
      invalidateSpy.mockClear()
      act(() => {
        es.simulateMessage({ type: 'stream_start' })
      })
      expect(invalidateSpy).not.toHaveBeenCalled()
    })

    it('does not retry after the picked-up command completes before another response starts', async () => {
      const { es, queryClient } = await setupHook('cmd-s5')
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

      act(() => {
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'started' })
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'completed' })
      })

      invalidateSpy.mockClear()
      act(() => {
        es.simulateMessage({ type: 'stream_start' })
      })
      expect(invalidateSpy).not.toHaveBeenCalled()
    })

    it('consumeDiscardedCommand removes a single uuid once acted upon', async () => {
      const { mod, result, es } = await setupHook('cmd-s3')

      act(() => {
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u1', state: 'discarded' })
        es.simulateMessage({ type: 'command_lifecycle', commandUuid: 'u2', state: 'discarded' })
      })
      act(() => {
        mod.consumeDiscardedCommand('cmd-s3', 'u1')
      })

      expect(result.current.discardedCommandUuids).toEqual(['u2'])
    })
  })

  // ---- Parallel tool call streaming ----

  describe('parallel tool calls', () => {
    it('supports multiple concurrent streaming tool uses', async () => {
      const { useMessageStream } = await getHookModule()
      const { result } = renderHook(
        () => useMessageStream('session-1', 'agent-1'),
        { wrapper: createWrapper() }
      )

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })

      // Start tool A
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-A',
          toolName: 'Bash',
          partialInput: '',
        })
      })

      // Start tool B while tool A is still streaming
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-B',
          toolName: 'Read',
          partialInput: '',
        })
      })

      // Both tools should be in streamingToolUses
      expect(result.current.streamingToolUses).toHaveLength(2)
      expect(result.current.streamingToolUses[0]).toEqual({
        id: 'tc-A',
        name: 'Bash',
        partialInput: '',
      })
      expect(result.current.streamingToolUses[1]).toEqual({
        id: 'tc-B',
        name: 'Read',
        partialInput: '',
      })
    })

    it('stream_delta preserves existing streamingToolUses', async () => {
      const { useMessageStream } = await getHookModule()
      const { result } = renderHook(
        () => useMessageStream('session-1', 'agent-1'),
        { wrapper: createWrapper() }
      )

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })

      // Start a tool
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-1',
          toolName: 'Bash',
          partialInput: '{"cmd":"ls"}',
        })
      })
      expect(result.current.streamingToolUses).toHaveLength(1)

      // Receive a stream_delta (text) — should NOT clear streamingToolUses
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'stream_delta',
          text: 'Some text',
        })
      })

      expect(result.current.streamingToolUses).toHaveLength(1)
      expect(result.current.streamingToolUses[0].id).toBe('tc-1')
      expect(result.current.streamingMessage).toBe('Some text')
    })

    it('tool_use_ready marks a specific tool as ready by toolId', async () => {
      const { useMessageStream } = await getHookModule()
      const { result } = renderHook(
        () => useMessageStream('session-1', 'agent-1'),
        { wrapper: createWrapper() }
      )

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })

      // Start two tools
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-A',
          toolName: 'Bash',
          partialInput: '{"cmd":"ls"}',
        })
      })
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-B',
          toolName: 'Read',
          partialInput: '{"file":"x.ts"}',
        })
      })

      // Mark only tool A as ready
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_ready',
          toolId: 'tc-A',
        })
      })

      expect(result.current.streamingToolUses).toHaveLength(2)
      expect(result.current.streamingToolUses[0]).toEqual({
        id: 'tc-A',
        name: 'Bash',
        partialInput: '{"cmd":"ls"}',
        ready: true,
      })
      // Tool B should NOT be marked as ready
      expect(result.current.streamingToolUses[1]).toEqual({
        id: 'tc-B',
        name: 'Read',
        partialInput: '{"file":"x.ts"}',
      })
    })

    it('tool_use_ready with unknown toolId is a no-op', async () => {
      const { useMessageStream } = await getHookModule()
      const { result } = renderHook(
        () => useMessageStream('session-1', 'agent-1'),
        { wrapper: createWrapper() }
      )

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })

      // Start one tool
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-1',
          toolName: 'Bash',
          partialInput: '',
        })
      })

      // Send tool_use_ready for a non-existent tool
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_ready',
          toolId: 'tc-nonexistent',
        })
      })

      // State should be unchanged — the existing tool should not be modified
      expect(result.current.streamingToolUses).toHaveLength(1)
      expect(result.current.streamingToolUses[0].ready).toBeUndefined()
    })

    it('tool_use_streaming upserts by toolId instead of replacing', async () => {
      const { useMessageStream } = await getHookModule()
      const { result } = renderHook(
        () => useMessageStream('session-1', 'agent-1'),
        { wrapper: createWrapper() }
      )

      act(() => {
        MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
      })

      // Start two tools
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-A',
          toolName: 'Bash',
          partialInput: '',
        })
      })
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_start',
          toolId: 'tc-B',
          toolName: 'Read',
          partialInput: '',
        })
      })

      // Update tool A via tool_use_streaming
      act(() => {
        MockEventSource.instances[0].simulateMessage({
          type: 'tool_use_streaming',
          toolId: 'tc-A',
          toolName: 'Bash',
          partialInput: '{"command": "ls -la"}',
        })
      })

      // Both tools should still be present; tool A updated, tool B unchanged
      expect(result.current.streamingToolUses).toHaveLength(2)
      expect(result.current.streamingToolUses[0]).toEqual({
        id: 'tc-A',
        name: 'Bash',
        partialInput: '{"command": "ls -la"}',
      })
      expect(result.current.streamingToolUses[1]).toEqual({
        id: 'tc-B',
        name: 'Read',
        partialInput: '',
      })
    })
  })

  // ---- Subagent resultText ----

  it('subagent_completed with resultText stores it in the SubagentInfo entry', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    // Start a subagent
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_delta',
        parentToolId: 'pt-1',
        text: 'Working on it...',
      })
    })

    // Complete with resultText
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_completed',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
        resultText: 'Task completed successfully. All files updated.',
      })
    })

    expect(result.current.completedSubagents?.has('pt-1')).toBe(true)
    const sub = result.current.activeSubagents.find(s => s.parentToolId === 'pt-1')
    expect(sub).toBeDefined()
    expect(sub?.resultText).toBe('Task completed successfully. All files updated.')
    // Streaming message should still be preserved
    expect(sub?.streamingMessage).toBe('Working on it...')
  })

  it('subagent_completed without resultText stores null for resultText', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_stream_start',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })

    // Complete without resultText
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'subagent_completed',
        parentToolId: 'pt-1',
        agentId: 'sub-1',
      })
    })

    const sub = result.current.activeSubagents.find(s => s.parentToolId === 'pt-1')
    expect(sub?.resultText).toBeNull()
  })

  // ============================================================================
  // Background Bash task events
  // ============================================================================

  it('tracks background tasks from SSE events', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    expect(result.current.backgroundTasks).toEqual([])

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'background_task_started',
        taskId: 'bg-1',
        startedAt: 1000,
      })
    })

    expect(result.current.backgroundTasks).toEqual([{ taskId: 'bg-1', startedAt: 1000 }])

    // Add second task
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'background_task_started',
        taskId: 'bg-2',
        startedAt: 2000,
      })
    })

    expect(result.current.backgroundTasks).toHaveLength(2)

    // Complete first task
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'background_task_completed',
        taskId: 'bg-1',
      })
    })

    expect(result.current.backgroundTasks).toEqual([{ taskId: 'bg-2', startedAt: 2000 }])
  })

  it('restores background tasks from connected event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected',
        isActive: true,
        backgroundTasks: [{ taskId: 'bg-restore', startedAt: 500 }],
      })
    })

    expect(result.current.backgroundTasks).toEqual([{ taskId: 'bg-restore', startedAt: 500 }])
  })

  it('clears background tasks on session_idle', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'background_task_started',
        taskId: 'bg-1',
        startedAt: 1000,
      })
    })

    expect(result.current.backgroundTasks).toHaveLength(1)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
    })

    expect(result.current.backgroundTasks).toEqual([])
  })

  it('preserves background tasks across session_active', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'background_task_started',
        taskId: 'bg-1',
        startedAt: 1000,
      })
    })

    expect(result.current.backgroundTasks).toHaveLength(1)

    // New turn starts — background tasks should be preserved
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })

    expect(result.current.backgroundTasks).toEqual([{ taskId: 'bg-1', startedAt: 1000 }])
  })

  it('sets isWaitingBackground on session_waiting_background event', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    expect(result.current.isWaitingBackground).toBe(false)

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'session_waiting_background',
        backgroundTaskCount: 1,
      })
    })

    expect(result.current.isWaitingBackground).toBe(true)
    expect(result.current.isActive).toBe(true)
  })

  it('clears isWaitingBackground when the last background task completes', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'background_task_started', taskId: 'bg-1', startedAt: 1000 })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_waiting_background', backgroundTaskCount: 1 })
    })
    expect(result.current.isWaitingBackground).toBe(true)

    // Last task completes — flag must clear even without a follow-up session_idle.
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'background_task_completed', taskId: 'bg-1' })
    })

    expect(result.current.backgroundTasks).toEqual([])
    expect(result.current.isWaitingBackground).toBe(false)
  })

  it('keeps isWaitingBackground while other background tasks remain', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'background_task_started', taskId: 'bg-1', startedAt: 1000 })
      MockEventSource.instances[0].simulateMessage({ type: 'background_task_started', taskId: 'bg-2', startedAt: 1100 })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_waiting_background', backgroundTaskCount: 2 })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'background_task_completed', taskId: 'bg-1' })
    })

    // One task still running → still waiting.
    expect(result.current.backgroundTasks).toHaveLength(1)
    expect(result.current.isWaitingBackground).toBe(true)
  })

  it('clears isWaitingBackground on session_active', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_waiting_background' })
    })

    expect(result.current.isWaitingBackground).toBe(true)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_active' })
    })

    expect(result.current.isWaitingBackground).toBe(false)
  })

  it('clears isWaitingBackground on stream_start (new turn)', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_waiting_background' })
    })

    expect(result.current.isWaitingBackground).toBe(true)

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })

    expect(result.current.isWaitingBackground).toBe(false)
  })

  it('restores isWaitingBackground from connected event with backgroundTasks', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected',
        isActive: true,
        backgroundTasks: [{ taskId: 'bg-1', startedAt: 500 }],
      })
    })

    expect(result.current.isWaitingBackground).toBe(true)
  })

  it('does not set isWaitingBackground from connected event without backgroundTasks', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    expect(result.current.isWaitingBackground).toBe(false)
  })
})

// The dynamic-workflow drawer is driven entirely by these four SSE events; the
// reducers do the live-merge that had the trickiest bugs (sticky terminal status,
// late-join stub, failed mapping), so they're exercised directly here.
describe('useMessageStream — workflow drawer reducers', () => {
  const es = () => MockEventSource.instances[0]
  const started = (over: Record<string, unknown> = {}) =>
    es().simulateMessage({ type: 'workflow_started', toolUseId: 'tu-wf', runId: 'wf_abc', name: 'My WF', startedAt: 1000, ...over })

  it('workflow_started upserts a run keyed by runId', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })

    act(() => { started() })

    expect(result.current.workflows).toHaveLength(1)
    expect(result.current.workflows[0]).toMatchObject({
      toolUseId: 'tu-wf', runId: 'wf_abc', name: 'My WF', startedAt: 1000, agents: {},
    })
  })

  it('workflow_started for an existing runId updates fields without duplicating', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { started() })

    act(() => { started({ name: 'Renamed' }) })

    expect(result.current.workflows).toHaveLength(1)
    expect(result.current.workflows[0].name).toBe('Renamed')
  })

  it('workflow_agent_updated patches per-agent status then result on completion', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { started() })

    act(() => { es().simulateMessage({ type: 'workflow_agent_updated', runId: 'wf_abc', agentId: 'a1', status: 'running', result: null }) })
    expect(result.current.workflows[0].agents.a1).toMatchObject({ status: 'running', result: null })

    act(() => { es().simulateMessage({ type: 'workflow_agent_updated', runId: 'wf_abc', agentId: 'a1', status: 'done', result: 'the answer' }) })
    expect(result.current.workflows[0].agents.a1).toMatchObject({ status: 'done', result: 'the answer' })
  })

  it('a stale running never downgrades a done agent (terminal sticky)', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { started() })
    act(() => { es().simulateMessage({ type: 'workflow_agent_updated', runId: 'wf_abc', agentId: 'a1', status: 'done', result: 'done!' }) })

    act(() => { es().simulateMessage({ type: 'workflow_agent_updated', runId: 'wf_abc', agentId: 'a1', status: 'running', result: null }) })

    expect(result.current.workflows[0].agents.a1).toMatchObject({ status: 'done', result: 'done!' })
  })

  it('workflow_agent_updated before workflow_started stubs the run (late-join)', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })

    act(() => { es().simulateMessage({ type: 'workflow_agent_updated', runId: 'wf_late', agentId: 'a1', status: 'running', result: null }) })

    const run = result.current.workflows.find(w => w.runId === 'wf_late')
    expect(run).toBeDefined()
    expect(run?.toolUseId).toBe('')
    expect(run?.agents.a1.status).toBe('running')
  })

  it('workflow_progress merges live metadata, maps failed, and sets workflow usage', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { started() })

    act(() => {
      es().simulateMessage({
        type: 'workflow_progress',
        runId: 'wf_abc',
        agents: [{ agentId: 'a1', label: 'boom', phase: 'Work', state: 'failed', tokens: 500, toolCalls: 3, lastTool: 'Bash throw' }],
        usage: { totalTokens: 900, toolUses: 5, durationMs: 1200 },
      })
    })

    expect(result.current.workflows[0].agents.a1).toMatchObject({
      status: 'failed', tokens: 500, toolCount: 3, lastTool: 'Bash throw', label: 'boom', phase: 'Work',
    })
    expect(result.current.workflows[0].usage).toEqual({ totalTokens: 900, toolUses: 5, durationMs: 1200 })
  })

  it('workflow_progress for an unknown run is a no-op (never stubs)', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })

    act(() => {
      es().simulateMessage({ type: 'workflow_progress', runId: 'wf_none', agents: [{ agentId: 'a1', state: 'progress' }] })
    })

    expect(result.current.workflows).toHaveLength(0)
  })

  it('workflow_progress does not downgrade a tailer-confirmed done agent, and keeps its result', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { started() })
    act(() => { es().simulateMessage({ type: 'workflow_agent_updated', runId: 'wf_abc', agentId: 'a1', status: 'done', result: 'disk result' }) })

    act(() => {
      es().simulateMessage({ type: 'workflow_progress', runId: 'wf_abc', agents: [{ agentId: 'a1', state: 'progress', tokens: 700 }] })
    })

    expect(result.current.workflows[0].agents.a1).toMatchObject({ status: 'done', result: 'disk result', tokens: 700 })
  })

  it('workflow_completed stamps completedAt on the matching run', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { started() })
    expect(result.current.workflows[0].completedAt).toBeUndefined()

    act(() => { es().simulateMessage({ type: 'workflow_completed', runId: 'wf_abc' }) })

    expect(typeof result.current.workflows[0].completedAt).toBe('number')
  })
})

describe('useMessageStream — extended thinking blocks', () => {
  async function setup() {
    const { useMessageStream } = await getHookModule()
    const rendered = renderHook(() => useMessageStream('session-1', 'agent-1'), { wrapper: createWrapper() })
    const es = () => MockEventSource.instances[MockEventSource.instances.length - 1]
    return { ...rendered, es }
  }

  it('opens a block on thinking_start and accumulates deltas onto it', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    expect(result.current.isThinking).toBe(true)
    expect(result.current.thinkingBlocks).toHaveLength(1)
    expect(result.current.thinkingBlocks[0]).toMatchObject({ text: '', endedAt: null })

    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'Let me ' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'reason.' }) })
    expect(result.current.thinkingBlocks).toHaveLength(1)
    expect(result.current.thinkingBlocks[0].text).toBe('Let me reason.')
    expect(result.current.thinkingBlocks[0].endedAt).toBeNull()
  })

  it('thinking_stop closes the block but keeps it readable for the rest of the turn', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'Deep thought.' }) })
    act(() => { es().simulateMessage({ type: 'thinking_stop' }) })

    expect(result.current.isThinking).toBe(false)
    expect(result.current.thinkingBlocks).toHaveLength(1)
    expect(result.current.thinkingBlocks[0].text).toBe('Deep thought.')
    expect(typeof result.current.thinkingBlocks[0].endedAt).toBe('number')
  })

  it('a bare thinking_delta opens a block (missed start after reconnect)', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'resumed mid-block' }) })

    expect(result.current.isThinking).toBe(true)
    expect(result.current.thinkingBlocks).toHaveLength(1)
    expect(result.current.thinkingBlocks[0]).toMatchObject({ text: 'resumed mid-block', endedAt: null })
  })

  it('a new thinking_start closes the previous block so at most one is live', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'first episode' }) })
    // No thinking_stop — the stop event was dropped
    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'second episode' }) })

    expect(result.current.thinkingBlocks).toHaveLength(2)
    expect(result.current.thinkingBlocks[0].text).toBe('first episode')
    expect(typeof result.current.thinkingBlocks[0].endedAt).toBe('number')
    expect(result.current.thinkingBlocks[1]).toMatchObject({ text: 'second episode', endedAt: null })
  })

  it('session_idle closes an open block (interrupt without thinking_stop)', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'connected', isActive: true }) })
    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'interrupted mid-thought' }) })
    act(() => { es().simulateMessage({ type: 'session_idle' }) })

    // The card must freeze at the real elapsed time, not tick forever or read 0s
    expect(result.current.isThinking).toBe(false)
    expect(result.current.thinkingBlocks).toHaveLength(1)
    expect(result.current.thinkingBlocks[0].text).toBe('interrupted mid-thought')
    expect(typeof result.current.thinkingBlocks[0].endedAt).toBe('number')
  })

  it('session_active resets blocks for the new turn', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'old turn' }) })
    act(() => { es().simulateMessage({ type: 'thinking_stop' }) })
    expect(result.current.thinkingBlocks).toHaveLength(1)

    act(() => { es().simulateMessage({ type: 'session_active' }) })

    expect(result.current.thinkingBlocks).toEqual([])
    expect(result.current.isThinking).toBe(false)
  })

  it('keeps the blocks array reference stable across unrelated events', async () => {
    const { result, es } = await setup()

    act(() => { es().simulateMessage({ type: 'thinking_start' }) })
    act(() => { es().simulateMessage({ type: 'thinking_delta', text: 'stable' }) })
    act(() => { es().simulateMessage({ type: 'thinking_stop' }) })
    const before = result.current.thinkingBlocks

    act(() => { es().simulateMessage({ type: 'stream_start' }) })
    act(() => { es().simulateMessage({ type: 'stream_delta', text: 'unrelated text' }) })

    // No thinking event fired — consumers must not re-derive from a fresh array
    expect(result.current.thinkingBlocks).toBe(before)
  })
})
