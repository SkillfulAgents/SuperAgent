// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePendingRequests, type PendingRequestDescriptor } from './use-pending-requests'
import { createAssistantMessage, createUserMessage, createToolCall } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

// Mock useMessages
const mockMessagesData: { data: ApiMessageOrBoundary[] | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
}

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
}))

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  pendingSecretRequests: [] as Array<{ toolUseId: string; secretName: string; reason?: string }>,
  pendingConnectedAccountRequests: [] as Array<{ toolUseId: string; toolkit: string; reason?: string }>,
  pendingRemoteMcpRequests: [] as Array<{ toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }>,
  pendingQuestionRequests: [] as Array<{ toolUseId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }>,
  pendingFileRequests: [] as Array<{ toolUseId: string; description: string; fileTypes?: string }>,
  pendingBrowserInputRequests: [] as Array<{ toolUseId: string; message: string; requirements: string[] }>,
  pendingScriptRunRequests: [] as Array<{ toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }>,
  pendingComputerUseRequests: [] as Array<{ toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }>,
  autoApprovedScriptRunIds: new Set<string>(),
}

const mockRemovers = {
  removeSecretRequest: vi.fn(),
  removeConnectedAccountRequest: vi.fn(),
  removeRemoteMcpRequest: vi.fn(),
  removeQuestionRequest: vi.fn(),
  removeFileRequest: vi.fn(),
  removeBrowserInputRequest: vi.fn(),
  removeScriptRunRequest: vi.fn(),
  removeComputerUseRequest: vi.fn(),
}

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  removeSecretRequest: (...args: unknown[]) => mockRemovers.removeSecretRequest(...args),
  removeConnectedAccountRequest: (...args: unknown[]) => mockRemovers.removeConnectedAccountRequest(...args),
  removeRemoteMcpRequest: (...args: unknown[]) => mockRemovers.removeRemoteMcpRequest(...args),
  removeQuestionRequest: (...args: unknown[]) => mockRemovers.removeQuestionRequest(...args),
  removeFileRequest: (...args: unknown[]) => mockRemovers.removeFileRequest(...args),
  removeBrowserInputRequest: (...args: unknown[]) => mockRemovers.removeBrowserInputRequest(...args),
  removeScriptRunRequest: (...args: unknown[]) => mockRemovers.removeScriptRunRequest(...args),
  removeComputerUseRequest: (...args: unknown[]) => mockRemovers.removeComputerUseRequest(...args),
}))

// Mock proxy reviews — mutable per test
type ProxyReviewMock = {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  displayText?: string
  xAgent?: {
    targetAgentSlug: string
    targetAgentName: string
    operation: 'list' | 'read' | 'invoke' | 'create'
    preview?: string
  }
}
const mockProxyReviewsData: { reviews: ProxyReviewMock[] } = { reviews: [] }
const mockRefetchProxyReviews = vi.fn()
vi.mock('@renderer/hooks/use-proxy-reviews', () => ({
  usePendingProxyReviews: () => ({ data: mockProxyReviewsData, refetch: mockRefetchProxyReviews }),
}))

const defaultArgs = {
  sessionId: 's-1',
  agentSlug: 'agent-1',
}

function ofKind<K extends PendingRequestDescriptor['kind']>(
  items: PendingRequestDescriptor[],
  kind: K,
): Extract<PendingRequestDescriptor, { kind: K }>[] {
  return items.filter((d): d is Extract<PendingRequestDescriptor, { kind: K }> => d.kind === kind)
}

describe('usePendingRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMessagesData.data = undefined
    mockMessagesData.isLoading = false
    mockProxyReviewsData.reviews = []
    Object.assign(mockStreamState, {
      isActive: false,
      pendingSecretRequests: [],
      pendingConnectedAccountRequests: [],
      pendingRemoteMcpRequests: [],
      pendingQuestionRequests: [],
      pendingFileRequests: [],
      pendingBrowserInputRequests: [],
      pendingScriptRunRequests: [],
      pendingComputerUseRequests: [],
      autoApprovedScriptRunIds: new Set<string>(),
    })
  })

  it('returns SSE-based pending secret requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-1', secretName: 'API_KEY' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'secret')
    expect(matches).toHaveLength(1)
    expect(matches[0].secretName).toBe('API_KEY')
  })

  it('returns SSE-based pending question requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingQuestionRequests = [
      {
        toolUseId: 'tu-q1',
        questions: [
          {
            question: 'Which DB?',
            header: 'DB',
            options: [{ label: 'PG', description: 'PostgreSQL' }],
            multiSelect: false,
          },
        ],
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'question')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolUseId).toBe('tu-q1')
  })

  it('returns SSE-based pending file requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingFileRequests = [
      { toolUseId: 'tu-f1', description: 'Upload config file' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'file')
    expect(matches).toHaveLength(1)
    expect(matches[0].description).toBe('Upload config file')
  })

  it('returns SSE-based pending connected account requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingConnectedAccountRequests = [
      { toolUseId: 'tu-ca-1', toolkit: 'slack', reason: 'Need access' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'connected_account')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolkit).toBe('slack')
  })

  it('returns SSE-based pending remote MCP requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingRemoteMcpRequests = [
      { toolUseId: 'tu-mcp-1', url: 'https://mcp.test.com', name: 'Test MCP' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'remote_mcp')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://mcp.test.com')
  })

  it('derives pending secret request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DB_PASSWORD', reason: 'For database' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'secret')
    expect(matches).toHaveLength(1)
    expect(matches[0].secretName).toBe('DB_PASSWORD')
  })

  it('does not derive pending requests from history when session is idle', () => {
    mockStreamState.isActive = false
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DB_PASSWORD' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
  })

  it('deduplicates SSE and message-based pending requests by toolUseId', () => {
    mockStreamState.isActive = true
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-dup', secretName: 'API_KEY' },
    ]
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tu-dup',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'API_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'secret')
    expect(matches).toHaveLength(1)
  })

  it('derives connected_account pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-ca',
            name: 'mcp__user-input__request_connected_account',
            input: { toolkit: 'github', reason: 'Need access' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'connected_account')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolkit).toBe('github')
  })

  it('derives question pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-q',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { question: 'Which env?', header: 'Env', options: [{ label: 'Prod', description: 'Production' }], multiSelect: false },
              ],
            },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'question')
    expect(matches).toHaveLength(1)
  })

  it('derives file pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-file',
            name: 'mcp__user-input__request_file',
            input: { description: 'Upload config', fileTypes: '.json' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'file')
    expect(matches).toHaveLength(1)
    expect(matches[0].description).toBe('Upload config')
  })

  it('derives remote MCP pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-mcp',
            name: 'mcp__user-input__request_remote_mcp',
            input: { url: 'https://mcp.example.com', name: 'Example' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'remote_mcp')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://mcp.example.com')
  })

  it('skips message-based requests when subsequent user message exists', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'API_KEY' },
            result: undefined,
          }),
        ],
      }),
      createUserMessage({ content: { text: 'never mind' } }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
  })

  it('skips message-based requests when tool call already has a result', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-done',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DONE_KEY' },
            result: 'provided',
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
  })

  it('pending user messages cause message-based extraction to skip (as if user moved on)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-skipped',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'SKIP_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() =>
      usePendingRequests({
        ...defaultArgs,
        pendingUserMessages: [{ uuid: 'pm-1', text: 'New input', sentAt: Date.now() }],
      }),
    )

    expect(result.current.count).toBe(0)
  })

  // ---- Dismissed-request set is cleared on active → idle transition ----

  it('clears dismissed-request set when session transitions active → idle', () => {
    mockStreamState.isActive = true
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-dismiss', secretName: 'API_KEY' },
    ]
    // Same request also derivable from messages (no result yet)
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tu-dismiss',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'API_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result, rerender } = renderHook(() => usePendingRequests(defaultArgs))
    expect(result.current.count).toBe(1)

    // User answers — invoke the descriptor's onComplete
    const item = ofKind(result.current.items, 'secret')[0]
    item.onComplete()

    // SSE clears it; messages-based source would resurface, but dismissed blocks it
    mockStreamState.pendingSecretRequests = []
    rerender()
    expect(result.current.count).toBe(0)

    // Session goes idle — message-based extraction is skipped anyway
    mockStreamState.isActive = false
    rerender()
    expect(result.current.count).toBe(0)

    // Session becomes active again — the message-based source would now
    // resurface the unanswered tool call, but only if dismissed was cleared
    // on the active → idle transition.
    mockStreamState.isActive = true
    rerender()
    expect(result.current.count).toBe(1)
  })

  // ---- Auto-approved script run filtering ----

  it('filters out script run requests whose toolUseId is auto-approved', () => {
    mockStreamState.pendingScriptRunRequests = [
      { toolUseId: 'tu-script-1', script: 'echo hi', explanation: 'manual', scriptType: 'shell' },
      { toolUseId: 'tu-script-2', script: 'echo bye', explanation: 'auto', scriptType: 'shell' },
    ]
    mockStreamState.autoApprovedScriptRunIds = new Set(['tu-script-2'])

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'script_run')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolUseId).toBe('tu-script-1')
  })

  // ---- Proxy reviews ----

  it('emits a proxy_review descriptor for non-xAgent reviews', () => {
    mockProxyReviewsData.reviews = [
      {
        id: 'review-1',
        agentSlug: 'agent-1',
        accountId: 'acct-1',
        toolkit: 'github',
        method: 'POST',
        targetPath: '/repos/me/secret',
        matchedScopes: ['repo:write'],
        scopeDescriptions: { 'repo:write': 'Write to repos' },
        displayText: 'Push to private repo',
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'proxy_review')
    expect(matches).toHaveLength(1)
    expect(matches[0].reviewId).toBe('review-1')
    expect(matches[0].displayText).toBe('Push to private repo')
  })

  it('emits an x_agent_review descriptor when xAgent metadata is present', () => {
    mockProxyReviewsData.reviews = [
      {
        id: 'review-x',
        agentSlug: 'agent-1',
        accountId: 'acct-x',
        toolkit: 'x',
        method: 'POST',
        targetPath: '/agent',
        matchedScopes: [],
        scopeDescriptions: {},
        displayText: 'Sub-agent review',
        xAgent: {
          targetAgentSlug: 'researcher',
          targetAgentName: 'Researcher',
          operation: 'invoke',
        },
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    expect(ofKind(result.current.items, 'x_agent_review')).toHaveLength(1)
    expect(ofKind(result.current.items, 'proxy_review')).toHaveLength(0)
  })

  it('proxy review onComplete triggers refetch', () => {
    mockProxyReviewsData.reviews = [
      {
        id: 'review-r',
        agentSlug: 'agent-1',
        accountId: 'acct-r',
        toolkit: 'gh',
        method: 'GET',
        targetPath: '/x',
        matchedScopes: [],
        scopeDescriptions: {},
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'proxy_review')[0].onComplete()
    expect(mockRefetchProxyReviews).toHaveBeenCalledTimes(1)
  })

  // ---- SSE onComplete wiring: each kind's onComplete must call the matching remove* ----

  it('secret onComplete calls removeSecretRequest with (sessionId, toolUseId)', () => {
    mockStreamState.pendingSecretRequests = [{ toolUseId: 'tu-s', secretName: 'A' }]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'secret')[0].onComplete()
    expect(mockRemovers.removeSecretRequest).toHaveBeenCalledTimes(1)
    expect(mockRemovers.removeSecretRequest).toHaveBeenCalledWith('s-1', 'tu-s')
  })

  it('connected_account onComplete calls removeConnectedAccountRequest', () => {
    mockStreamState.pendingConnectedAccountRequests = [{ toolUseId: 'tu-c', toolkit: 'slack' }]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'connected_account')[0].onComplete()
    expect(mockRemovers.removeConnectedAccountRequest).toHaveBeenCalledWith('s-1', 'tu-c')
  })

  it('remote_mcp onComplete calls removeRemoteMcpRequest', () => {
    mockStreamState.pendingRemoteMcpRequests = [{ toolUseId: 'tu-m', url: 'https://x' }]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'remote_mcp')[0].onComplete()
    expect(mockRemovers.removeRemoteMcpRequest).toHaveBeenCalledWith('s-1', 'tu-m')
  })

  it('question onComplete calls removeQuestionRequest', () => {
    mockStreamState.pendingQuestionRequests = [{
      toolUseId: 'tu-q',
      questions: [{ question: 'Q?', header: 'H', options: [], multiSelect: false }],
    }]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'question')[0].onComplete()
    expect(mockRemovers.removeQuestionRequest).toHaveBeenCalledWith('s-1', 'tu-q')
  })

  it('file onComplete calls removeFileRequest', () => {
    mockStreamState.pendingFileRequests = [{ toolUseId: 'tu-f', description: 'd' }]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'file')[0].onComplete()
    expect(mockRemovers.removeFileRequest).toHaveBeenCalledWith('s-1', 'tu-f')
  })

  it('browser_input onComplete calls removeBrowserInputRequest', () => {
    mockStreamState.pendingBrowserInputRequests = [{ toolUseId: 'tu-b', message: 'm', requirements: [] }]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'browser_input')[0].onComplete()
    expect(mockRemovers.removeBrowserInputRequest).toHaveBeenCalledWith('s-1', 'tu-b')
  })

  it('script_run onComplete calls removeScriptRunRequest', () => {
    mockStreamState.pendingScriptRunRequests = [
      { toolUseId: 'tu-r', script: 'echo', explanation: '', scriptType: 'shell' },
    ]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'script_run')[0].onComplete()
    expect(mockRemovers.removeScriptRunRequest).toHaveBeenCalledWith('s-1', 'tu-r')
  })

  it('computer_use onComplete calls removeComputerUseRequest', () => {
    mockStreamState.pendingComputerUseRequests = [
      { toolUseId: 'tu-cu', method: 'click', params: {}, permissionLevel: 'high' },
    ]
    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'computer_use')[0].onComplete()
    expect(mockRemovers.removeComputerUseRequest).toHaveBeenCalledWith('s-1', 'tu-cu')
  })

  // ---- Arrival-order sort across mixed types ----

  it('sorts mixed-type requests by chronological arrival order across renders', () => {
    // First batch: a single secret request arrives
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-secret', secretName: 'A' },
    ]

    const { result, rerender } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.items.map((d) => d.key)).toEqual(['tu-secret'])

    // Second batch: a file request arrives later — should sort after the secret
    mockStreamState.pendingFileRequests = [
      { toolUseId: 'tu-file', description: 'Upload' },
    ]
    rerender()

    expect(result.current.items.map((d) => d.key)).toEqual(['tu-secret', 'tu-file'])

    // Third batch: another secret arrives last — sorts after both even though
    // the secret block comes first in the iteration order inside the hook.
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-secret', secretName: 'A' },
      { toolUseId: 'tu-secret-2', secretName: 'B' },
    ]
    rerender()

    expect(result.current.items.map((d) => d.key)).toEqual([
      'tu-secret',
      'tu-file',
      'tu-secret-2',
    ])
  })
})
