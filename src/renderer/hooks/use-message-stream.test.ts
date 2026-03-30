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
    expect(result.current.streamingToolUse).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.pendingSecretRequests).toEqual([])
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

  it('handles secret_request event', async () => {
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
        type: 'secret_request',
        toolUseId: 'tu-1',
        secretName: 'API_KEY',
        reason: 'Need it',
      })
    })

    expect(result.current.pendingSecretRequests).toHaveLength(1)
    expect(result.current.pendingSecretRequests[0]).toEqual({
      toolUseId: 'tu-1',
      secretName: 'API_KEY',
      reason: 'Need it',
    })
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

    expect(result.current.streamingToolUse).toEqual({
      id: 'tc-1',
      name: 'Bash',
      partialInput: '',
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'tool_use_streaming',
        toolId: 'tc-1',
        toolName: 'Bash',
        partialInput: '{"command": "ls"}',
      })
    })

    expect(result.current.streamingToolUse?.partialInput).toBe('{"command": "ls"}')
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

  it('handles removeSecretRequest helper', async () => {
    const { useMessageStream, removeSecretRequest } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'secret_request',
        toolUseId: 'tu-1',
        secretName: 'KEY1',
      })
    })

    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'secret_request',
        toolUseId: 'tu-2',
        secretName: 'KEY2',
      })
    })

    expect(result.current.pendingSecretRequests).toHaveLength(2)

    act(() => {
      removeSecretRequest('session-1', 'tu-1')
    })

    expect(result.current.pendingSecretRequests).toHaveLength(1)
    expect(result.current.pendingSecretRequests[0].toolUseId).toBe('tu-2')
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

  it('handles connected_account_request event', async () => {
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
        type: 'connected_account_request',
        toolUseId: 'tu-ca-1',
        toolkit: 'github',
        reason: 'Need repo access',
      })
    })

    expect(result.current.pendingConnectedAccountRequests).toHaveLength(1)
    expect(result.current.pendingConnectedAccountRequests[0]).toEqual({
      toolUseId: 'tu-ca-1',
      toolkit: 'github',
      reason: 'Need repo access',
    })
  })

  it('handles user_question_request event', async () => {
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
        type: 'user_question_request',
        toolUseId: 'tu-q-1',
        questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'PG', description: 'PostgreSQL' }], multiSelect: false }],
      })
    })

    expect(result.current.pendingQuestionRequests).toHaveLength(1)
    expect(result.current.pendingQuestionRequests[0].toolUseId).toBe('tu-q-1')
    expect(result.current.pendingQuestionRequests[0].questions[0].question).toBe('Which DB?')
  })

  it('handles file_request event', async () => {
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
        type: 'file_request',
        toolUseId: 'tu-f-1',
        description: 'Upload your config',
        fileTypes: '.json,.yaml',
      })
    })

    expect(result.current.pendingFileRequests).toHaveLength(1)
    expect(result.current.pendingFileRequests[0]).toEqual({
      toolUseId: 'tu-f-1',
      description: 'Upload your config',
      fileTypes: '.json,.yaml',
    })
  })

  it('handles remote_mcp_request event', async () => {
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
        type: 'remote_mcp_request',
        toolUseId: 'tu-mcp-1',
        url: 'https://mcp.example.com',
        name: 'Example MCP',
        reason: 'Need tools',
      })
    })

    expect(result.current.pendingRemoteMcpRequests).toHaveLength(1)
    expect(result.current.pendingRemoteMcpRequests[0]).toEqual({
      toolUseId: 'tu-mcp-1',
      url: 'https://mcp.example.com',
      name: 'Example MCP',
      reason: 'Need tools',
    })
  })

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
      MockEventSource.instances[0].simulateMessage({ type: 'tool_use_ready' })
    })

    // Tool use should still be visible
    expect(result.current.streamingToolUse).toEqual({
      id: 'tc-1',
      name: 'Bash',
      partialInput: '{"cmd":"ls"}',
    })
    expect(result.current.isStreaming).toBe(true)
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

  it('handles removeConnectedAccountRequest helper', async () => {
    const { useMessageStream, removeConnectedAccountRequest } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected_account_request',
        toolUseId: 'tu-ca-1',
        toolkit: 'github',
      })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'connected_account_request',
        toolUseId: 'tu-ca-2',
        toolkit: 'slack',
      })
    })
    expect(result.current.pendingConnectedAccountRequests).toHaveLength(2)

    act(() => {
      removeConnectedAccountRequest('session-1', 'tu-ca-1')
    })

    expect(result.current.pendingConnectedAccountRequests).toHaveLength(1)
    expect(result.current.pendingConnectedAccountRequests[0].toolkit).toBe('slack')
  })

  it('handles removeQuestionRequest helper', async () => {
    const { useMessageStream, removeQuestionRequest } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'user_question_request',
        toolUseId: 'tu-q-1',
        questions: [{ question: 'Q1?', header: 'H', options: [], multiSelect: false }],
      })
    })
    expect(result.current.pendingQuestionRequests).toHaveLength(1)

    act(() => {
      removeQuestionRequest('session-1', 'tu-q-1')
    })

    expect(result.current.pendingQuestionRequests).toHaveLength(0)
  })

  it('handles removeFileRequest helper', async () => {
    const { useMessageStream, removeFileRequest } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'file_request',
        toolUseId: 'tu-f-1',
        description: 'Upload config',
      })
    })
    expect(result.current.pendingFileRequests).toHaveLength(1)

    act(() => {
      removeFileRequest('session-1', 'tu-f-1')
    })

    expect(result.current.pendingFileRequests).toHaveLength(0)
  })

  it('handles removeRemoteMcpRequest helper', async () => {
    const { useMessageStream, removeRemoteMcpRequest } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({
        type: 'remote_mcp_request',
        toolUseId: 'tu-mcp-1',
        url: 'https://mcp.example.com',
      })
    })
    expect(result.current.pendingRemoteMcpRequests).toHaveLength(1)

    act(() => {
      removeRemoteMcpRequest('session-1', 'tu-mcp-1')
    })

    expect(result.current.pendingRemoteMcpRequests).toHaveLength(0)
  })

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

  it('session_idle clears all pending requests', async () => {
    const { useMessageStream } = await getHookModule()
    const { result } = renderHook(
      () => useMessageStream('session-1', 'agent-1'),
      { wrapper: createWrapper() }
    )

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected', isActive: true })
    })

    // Accumulate pending requests of all types
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'secret_request', toolUseId: 'tu-1', secretName: 'KEY' })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'connected_account_request', toolUseId: 'tu-2', toolkit: 'gh' })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'user_question_request', toolUseId: 'tu-3', questions: [] })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'file_request', toolUseId: 'tu-4', description: 'file' })
    })
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'remote_mcp_request', toolUseId: 'tu-5', url: 'http://x' })
    })

    expect(result.current.pendingSecretRequests).toHaveLength(1)
    expect(result.current.pendingConnectedAccountRequests).toHaveLength(1)
    expect(result.current.pendingQuestionRequests).toHaveLength(1)
    expect(result.current.pendingFileRequests).toHaveLength(1)
    expect(result.current.pendingRemoteMcpRequests).toHaveLength(1)

    // session_idle should clear all
    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'session_idle' })
    })

    expect(result.current.pendingSecretRequests).toHaveLength(0)
    expect(result.current.pendingConnectedAccountRequests).toHaveLength(0)
    expect(result.current.pendingQuestionRequests).toHaveLength(0)
    expect(result.current.pendingFileRequests).toHaveLength(0)
    expect(result.current.pendingRemoteMcpRequests).toHaveLength(0)
  })

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
    expect(result.current.streamingToolUse).toBeNull()
  })

  it('stream_start invalidates messages when previous streamingToolUse exists', async () => {
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
    expect(result.current.streamingToolUse).not.toBeNull()
    spy.mockClear()

    act(() => {
      MockEventSource.instances[0].simulateMessage({ type: 'stream_start' })
    })

    // Should invalidate messages to fetch persisted tool call before clearing streaming state
    expect(spy).toHaveBeenCalledWith({ queryKey: ['messages', 'session-1'] })
    expect(result.current.streamingToolUse).toBeNull()
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

  describe('script_run_request event', () => {
    it('adds script run request to pending list', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-1', 'agent-1'),
        { wrapper }
      )

      // Wait for EventSource to be created
      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })

      const es = MockEventSource.instances[MockEventSource.instances.length - 1]

      // Send connected event first
      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })

      // Send script_run_request event
      act(() => {
        es.simulateMessage({
          type: 'script_run_request',
          toolUseId: 'tool-1',
          script: 'sw_vers',
          explanation: 'Check macOS version',
          scriptType: 'shell',
        })
      })

      await vi.waitFor(() => {
        expect(result.current.pendingScriptRunRequests).toHaveLength(1)
      })

      expect(result.current.pendingScriptRunRequests[0]).toEqual({
        toolUseId: 'tool-1',
        script: 'sw_vers',
        explanation: 'Check macOS version',
        scriptType: 'shell',
      })
    })

    it('deduplicates script run requests by toolUseId', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-2', 'agent-1'),
        { wrapper }
      )

      await vi.waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0)
      })

      const es = MockEventSource.instances[MockEventSource.instances.length - 1]

      act(() => {
        es.simulateMessage({ type: 'connected', isActive: true })
      })

      // Send same toolUseId twice
      act(() => {
        es.simulateMessage({
          type: 'script_run_request',
          toolUseId: 'tool-dup',
          script: 'sw_vers',
          explanation: 'Check version',
          scriptType: 'shell',
        })
      })

      act(() => {
        es.simulateMessage({
          type: 'script_run_request',
          toolUseId: 'tool-dup',
          script: 'sw_vers',
          explanation: 'Check version',
          scriptType: 'shell',
        })
      })

      await vi.waitFor(() => {
        expect(result.current.pendingScriptRunRequests).toHaveLength(1)
      })
    })

    it('clears script run requests on session_idle', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-3', 'agent-1'),
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
          type: 'script_run_request',
          toolUseId: 'tool-clear',
          script: 'test',
          explanation: 'Test',
          scriptType: 'shell',
        })
      })

      await vi.waitFor(() => {
        expect(result.current.pendingScriptRunRequests).toHaveLength(1)
      })

      act(() => {
        es.simulateMessage({ type: 'session_idle' })
      })

      await vi.waitFor(() => {
        expect(result.current.pendingScriptRunRequests).toHaveLength(0)
      })
    })

    it('removeScriptRunRequest removes by toolUseId', async () => {
      const mod = await getHookModule()
      const wrapper = createWrapper()

      const { result } = renderHook(
        () => mod.useMessageStream('session-4', 'agent-1'),
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
          type: 'script_run_request',
          toolUseId: 'tool-remove',
          script: 'test',
          explanation: 'Test',
          scriptType: 'shell',
        })
      })

      await vi.waitFor(() => {
        expect(result.current.pendingScriptRunRequests).toHaveLength(1)
      })

      act(() => {
        mod.removeScriptRunRequest('session-4', 'tool-remove')
      })

      await vi.waitFor(() => {
        expect(result.current.pendingScriptRunRequests).toHaveLength(0)
      })
    })
  })
})
