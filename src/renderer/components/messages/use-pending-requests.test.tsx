// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePendingRequests, type PendingRequestDescriptor } from './use-pending-requests'
import { createAssistantMessage, createUserMessage, createToolCall } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'

// Mock useMessages
const mockMessagesData: { data: ApiMessageOrBoundary[] | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
}

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
}))

// Mock useMessageStream — the hook only reads lifecycle/streaming state from it
// now; the per-kind pending arrays moved to the unified store.
const mockStreamState = {
  isActive: false,
  streamingToolUses: [] as Array<{ id: string; name: string; partialInput: string; ready?: boolean }>,
  autoApprovedScriptRunIds: new Set<string>(),
  autoApprovedComputerUseIds: new Set<string>(),
}

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
}))

// Mock the unified pending-request store — mutable per test.
const mockUnified: { data: PendingUserInputRequest[] | undefined } = { data: [] }
vi.mock('@renderer/hooks/use-pending-user-requests', () => ({
  usePendingUserRequests: () => ({ data: mockUnified.data }),
}))

// The hook uses the query client only to invalidate on review completion —
// keep the real module surface (spread) so new exports don't break the mock.
const mockInvalidateQueries = vi.fn()
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

/** Build a unified registry envelope the way the server snapshot returns it. */
function unified(
  kind: PendingUserInputRequest['kind'],
  id: string,
  payload: Record<string, unknown>,
  opts: { autoApproved?: boolean; agentScoped?: boolean } = {},
): PendingUserInputRequest {
  return {
    id,
    kind,
    scope: opts.agentScoped
      ? { agentSlug: 'agent-1' }
      : { agentSlug: 'agent-1', sessionId: 's-1' },
    blocking: true,
    autoApproved: opts.autoApproved ?? false,
    payload,
  } as unknown as PendingUserInputRequest
}

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
    mockUnified.data = []
    Object.assign(mockStreamState, {
      isActive: false,
      streamingToolUses: [],
      autoApprovedScriptRunIds: new Set<string>(),
      autoApprovedComputerUseIds: new Set<string>(),
    })
  })

  it('returns unified-store pending secret requests', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [unified('secret', 'tu-1', { secretName: 'API_KEY' })]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'secret')
    expect(matches).toHaveLength(1)
    expect(matches[0].secretName).toBe('API_KEY')
  })

  it('returns unified-store pending question requests', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [
      unified('question', 'tu-q1', {
        questions: [
          {
            question: 'Which DB?',
            header: 'DB',
            options: [{ label: 'PG', description: 'PostgreSQL' }],
            multiSelect: false,
          },
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'question')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolUseId).toBe('tu-q1')
  })

  it('returns unified-store pending file requests', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [unified('file', 'tu-f1', { description: 'Upload config file' })]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'file')
    expect(matches).toHaveLength(1)
    expect(matches[0].description).toBe('Upload config file')
  })

  it('returns unified-store pending connected account requests', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [
      unified('connected_account', 'tu-ca-1', { toolkit: 'slack', reason: 'Need access' }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'connected_account')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolkit).toBe('slack')
  })

  it('returns unified-store pending remote MCP requests', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [
      unified('remote_mcp', 'tu-mcp-1', { url: 'https://mcp.test.com', name: 'Test MCP' }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'remote_mcp')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://mcp.test.com')
  })

  it('a recovered synthetic envelope renders no card — the transcript covers it', () => {
    // Recovered entries are now IN the snapshot (they are blocking waits the
    // activity indicator must count) but carry no renderable payload; the
    // per-kind guards must drop them rather than draw a broken card.
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [unified('secret', 'tu-recovered', { recovered: true })]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    expect(result.current.count).toBe(0)
  })

  it('normalizes malformed questions on a unified envelope — a question without options still renders', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    // The model can omit `options` (or emit garbage). The card indexes
    // options unconditionally, so the projection must run the same
    // normalizer the message-history recovery path uses — raw passthrough
    // crashes the card, and (unlike legacy) a reload would not heal it
    // because the unified bucket wins the dedupe.
    mockUnified.data = [
      unified('question', 'tu-q-bad', {
        questions: [{ question: 'Pick one?', header: 'DB', multiSelect: false }],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'question')
    expect(matches).toHaveLength(1)
    expect(matches[0].questions[0].options).toEqual([])
  })

  it('onComplete hides the card synchronously — before any store refetch settles it', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [unified('secret', 'tu-sync', { secretName: 'A' })]

    const { result, rerender } = renderHook(() => usePendingRequests(defaultArgs))
    expect(result.current.count).toBe(1)

    // Answer the card but leave EVERY source untouched: the unified store
    // still lists the entry (the settle is a server round trip away). The
    // dismissal alone must remove it — this is the state-not-ref property;
    // a ref here would leave the answered card up until the refetch lands.
    act(() => {
      ofKind(result.current.items, 'secret')[0].onComplete()
    })
    rerender()
    expect(result.current.count).toBe(0)
  })

  it('a lenient envelope missing its card-critical field renders nothing (no broken card)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    // The server accepts malformed tool input rather than dropping the wait;
    // the projection must re-validate instead of drawing a crashing card.
    mockUnified.data = [unified('secret', 'tu-bad', { reason: 'no name' })]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    expect(result.current.count).toBe(0)
  })

  it('hides session-scoped unified entries while the session is idle, but keeps agent-scoped reviews', () => {
    // e.g. an abandoned computer-use approval survives the idle boundary
    // server-side for reconnect replay — rendering it on an idle session
    // would gate the composer behind a dead card. Reviews outlive turns.
    mockStreamState.isActive = false
    mockUnified.data = [
      unified('computer_use', 'tu-cu-idle', { method: 'click', params: {}, permissionLevel: 'use_application' }),
      unified(
        'proxy_review',
        'review-live',
        { accountId: 'a', toolkit: 'gh', method: 'GET', targetPath: '/x', matchedScopes: [], scopeDescriptions: {} },
        { agentScoped: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    expect(ofKind(result.current.items, 'computer_use')).toHaveLength(0)
    expect(ofKind(result.current.items, 'proxy_review')).toHaveLength(1)
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

  it('derives pending secret request from ready streaming tool use when the event is missed', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockStreamState.streamingToolUses = [
      {
        id: 'stream-secret',
        name: 'mcp__user-input__request_secret',
        partialInput: JSON.stringify({
          secretName: 'OPENAI_API_KEY',
          reason: 'Needed for API access',
        }),
        ready: true,
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'secret')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      toolUseId: 'stream-secret',
      secretName: 'OPENAI_API_KEY',
      reason: 'Needed for API access',
    })
  })

  it('ignores non-ready streaming request tool use until input is parseable', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockStreamState.streamingToolUses = [
      {
        id: 'stream-secret',
        name: 'mcp__user-input__request_secret',
        partialInput: '{"secretName":"OPEN',
        ready: false,
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
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

  it('deduplicates unified-store and message-based pending requests by toolUseId', () => {
    mockStreamState.isActive = true
    mockUnified.data = [unified('secret', 'tu-dup', { secretName: 'API_KEY' })]
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

  it('derives question pending request from stringified history input without unsafe casts', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-q-string',
            name: 'AskUserQuestion',
            input: {
              questions: JSON.stringify([
                { question: 'Which env?', options: [{ label: 'Prod' }], multiSelect: false },
              ]),
            },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'question')
    expect(matches).toHaveLength(1)
    expect(matches[0].questions).toEqual([
      { question: 'Which env?', header: '', options: [{ label: 'Prod', description: '' }], multiSelect: false },
    ])
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

  it('derives computer-use pending request from message history when active and not auto-approved', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-cu',
            name: 'mcp__computer-use__computer_apps',
            input: { includeHidden: false },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'computer_use')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      toolUseId: 'tc-cu',
      method: 'apps',
      params: { includeHidden: false },
      permissionLevel: 'list_apps_windows',
    })
  })

  it('suppresses computer-use message-history fallback when the backend auto-approved it', () => {
    mockStreamState.isActive = true
    mockStreamState.autoApprovedComputerUseIds = new Set(['tc-cu-auto'])
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-cu-auto',
            name: 'mcp__computer-use__computer_apps',
            input: { includeHidden: false },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(ofKind(result.current.items, 'computer_use')).toHaveLength(0)
  })

  it('derives computer-use pending request from ready streaming tool use', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockStreamState.streamingToolUses = [
      {
        id: 'stream-cu',
        name: 'mcp__computer-use__computer_click',
        partialInput: JSON.stringify({ app: 'Safari', x: 10, y: 20 }),
        ready: true,
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'computer_use')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      toolUseId: 'stream-cu',
      method: 'click',
      params: { app: 'Safari', x: 10, y: 20 },
      permissionLevel: 'use_application',
      appName: 'Safari',
    })
  })

  it('suppresses computer-use streaming fallback when the backend auto-approved it', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockStreamState.autoApprovedComputerUseIds = new Set(['stream-cu-auto'])
    mockStreamState.streamingToolUses = [
      {
        id: 'stream-cu-auto',
        name: 'mcp__computer-use__computer_click',
        partialInput: JSON.stringify({ app: 'Safari', x: 10, y: 20 }),
        ready: true,
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(ofKind(result.current.items, 'computer_use')).toHaveLength(0)
  })

  it('an auto-approved unified computer-use entry renders no approval card', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [
      unified(
        'computer_use',
        'tu-cu-auto',
        { method: 'apps', params: {}, permissionLevel: 'list_apps_windows' },
        { autoApproved: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    expect(ofKind(result.current.items, 'computer_use')).toHaveLength(0)
  })

  it('coerces a non-array requirements to [] (model emitted a bare string)', () => {
    // Regression: the model can emit `requirements` as a string instead of a
    // string[]. The old `input.requirements || []` guard let a non-empty string
    // through, which then crashed `.map()` in the request card. The intake must
    // coerce any non-array to [].
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-bi',
            name: 'mcp__user-input__request_browser_input',
            input: { message: 'Log in', requirements: 'Enter your email and password' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'browser_input')
    expect(matches).toHaveLength(1)
    expect(matches[0].requirements).toEqual([])
  })

  it('coerces a non-array requirements to [] on a unified envelope too', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [
      unified('browser_input', 'tu-bi', { message: 'Log in', requirements: 'not-an-array' }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'browser_input')
    expect(matches).toHaveLength(1)
    expect(matches[0].requirements).toEqual([])
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
        pendingUserMessages: [{ localId: 'pm-1', uuid: 'pm-1', text: 'New input', sentAt: Date.now() }],
      }),
    )

    expect(result.current.count).toBe(0)
  })

  // ---- Dismissed-request set is cleared on active → idle transition ----

  it('clears dismissed-request set when session transitions active → idle', () => {
    mockStreamState.isActive = true
    mockUnified.data = [unified('secret', 'tu-dismiss', { secretName: 'API_KEY' })]
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

    // The store settles it; messages-based source would resurface, but dismissed blocks it
    mockUnified.data = []
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

  it('filters out auto-approved script run entries (visible in the store, not a wait)', () => {
    mockStreamState.isActive = true
    mockUnified.data = [
      unified('script_run', 'tu-script-1', { script: 'echo hi', explanation: 'manual', scriptType: 'shell' }),
      unified(
        'script_run',
        'tu-script-2',
        { script: 'echo bye', explanation: 'auto', scriptType: 'shell' },
        { autoApproved: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'script_run')
    expect(matches).toHaveLength(1)
    expect(matches[0].toolUseId).toBe('tu-script-1')
  })

  // ---- Proxy reviews (agent-scoped envelopes in the same store) ----

  it('emits a proxy_review descriptor for non-xAgent reviews', () => {
    mockUnified.data = [
      unified(
        'proxy_review',
        'review-1',
        {
          accountId: 'acct-1',
          toolkit: 'github',
          method: 'POST',
          targetPath: '/repos/me/secret',
          matchedScopes: ['repo:write'],
          scopeDescriptions: { 'repo:write': 'Write to repos' },
          displayText: 'Push to private repo',
        },
        { agentScoped: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = ofKind(result.current.items, 'proxy_review')
    expect(matches).toHaveLength(1)
    expect(matches[0].reviewId).toBe('review-1')
    expect(matches[0].displayText).toBe('Push to private repo')
    expect(matches[0].scopeDescriptions).toEqual({ 'repo:write': 'Write to repos' })
  })

  it('emits an x_agent_review descriptor when xAgent metadata is present', () => {
    mockUnified.data = [
      unified(
        'x_agent_review',
        'review-x',
        {
          accountId: 'acct-x',
          toolkit: 'x',
          method: 'POST',
          targetPath: '/agent',
          matchedScopes: [],
          scopeDescriptions: {},
          xAgent: {
            targetAgentSlug: 'researcher',
            targetAgentName: 'Researcher',
            operation: 'invoke',
          },
        },
        { agentScoped: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    expect(ofKind(result.current.items, 'x_agent_review')).toHaveLength(1)
    expect(ofKind(result.current.items, 'proxy_review')).toHaveLength(0)
  })

  it('an x_agent_review envelope with malformed xAgent metadata renders nothing', () => {
    mockUnified.data = [
      unified(
        'x_agent_review',
        'review-bad',
        {
          accountId: 'acct-x',
          toolkit: 'x',
          method: 'POST',
          targetPath: '/agent',
          xAgent: { operation: 'invoke' },
        },
        { agentScoped: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    expect(result.current.count).toBe(0)
  })

  it('proxy review onComplete invalidates the unified store', () => {
    mockUnified.data = [
      unified(
        'proxy_review',
        'review-r',
        { accountId: 'acct-r', toolkit: 'gh', method: 'GET', targetPath: '/x', matchedScopes: [], scopeDescriptions: {} },
        { agentScoped: true },
      ),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    ofKind(result.current.items, 'proxy_review')[0].onComplete()
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['pending-user-requests'] })
  })

  // ---- onComplete wiring: every kind drops its card synchronously ----

  it.each([
    ['secret', 'tu-s', { secretName: 'A' }],
    ['connected_account', 'tu-c', { toolkit: 'slack' }],
    ['remote_mcp', 'tu-m', { url: 'https://x' }],
    ['question', 'tu-q', { questions: [{ question: 'Q?', header: 'H', options: [], multiSelect: false }] }],
    ['file', 'tu-f', { description: 'd' }],
    ['browser_input', 'tu-b', { message: 'm', requirements: [] }],
    ['script_run', 'tu-r', { script: 'echo', explanation: '', scriptType: 'shell' }],
    ['computer_use', 'tu-cu', { method: 'click', params: {}, permissionLevel: 'high' }],
  ] as const)('%s onComplete drops the card without waiting for the snapshot', (kind, toolUseId, payload) => {
    mockStreamState.isActive = true
    mockUnified.data = [unified(kind, toolUseId, payload as Record<string, unknown>)]
    const { result, rerender } = renderHook(() => usePendingRequests(defaultArgs))
    expect(ofKind(result.current.items, kind)).toHaveLength(1)

    act(() => {
      ofKind(result.current.items, kind)[0].onComplete()
    })
    // The snapshot still lists it — answering must not leave the card up
    // until the refetch lands.
    rerender()
    expect(ofKind(result.current.items, kind)).toHaveLength(0)
  })

  // ---- Arrival-order sort across mixed types ----

  it('sorts mixed-type requests by chronological arrival order across renders', () => {
    mockStreamState.isActive = true
    // First batch: a single secret request arrives
    mockUnified.data = [unified('secret', 'tu-secret', { secretName: 'A' })]

    const { result, rerender } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.items.map((d) => d.key)).toEqual(['tu-secret'])

    // Second batch: a file request arrives later — should sort after the secret
    mockUnified.data = [
      unified('secret', 'tu-secret', { secretName: 'A' }),
      unified('file', 'tu-file', { description: 'Upload' }),
    ]
    rerender()

    expect(result.current.items.map((d) => d.key)).toEqual(['tu-secret', 'tu-file'])

    // Third batch: another secret arrives last — sorts after both even though
    // the secret block comes first in the iteration order inside the hook.
    mockUnified.data = [
      unified('secret', 'tu-secret', { secretName: 'A' }),
      unified('file', 'tu-file', { description: 'Upload' }),
      unified('secret', 'tu-secret-2', { secretName: 'B' }),
    ]
    rerender()

    expect(result.current.items.map((d) => d.key)).toEqual([
      'tu-secret',
      'tu-file',
      'tu-secret-2',
    ])
  })

  it('returns unified-store capability review requests while active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = []
    mockUnified.data = [
      unified('capability_review', 'tu-cap-1', {
        capability: 'workflows',
        toolName: 'Workflow',
        input: { name: 'audit' },
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = ofKind(result.current.items, 'capability_review')
    expect(matches).toHaveLength(1)
    expect(matches[0].capability).toBe('workflows')
    expect(matches[0].input).toEqual({ name: 'audit' })
  })

  it('hides capability reviews while the session is idle', () => {
    mockStreamState.isActive = false
    mockUnified.data = [
      unified('capability_review', 'tu-cap-idle', {
        capability: 'workflows',
        toolName: 'Workflow',
        input: {},
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))
    expect(ofKind(result.current.items, 'capability_review')).toHaveLength(0)
  })

  it('does NOT derive capability reviews from message history — a running Task without a result is not an approval', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-task',
            name: 'Task',
            input: { subagent_type: 'Explore', prompt: 'look around' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(ofKind(result.current.items, 'capability_review')).toHaveLength(0)
  })
})
