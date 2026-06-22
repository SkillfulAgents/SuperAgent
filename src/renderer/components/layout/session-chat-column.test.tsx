// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { SessionChatColumn } from './session-chat-column'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { carryoverKey, summaryKey, type ComposerSnapshot, type NewChatCarryover, type NewChatSummary } from '@renderer/lib/composer-carryover'
import type { SessionUsage } from '@shared/lib/types/agent'
import type { PendingRequestDescriptor } from '@renderer/components/messages/use-pending-requests'

const { mockSummarize } = vi.hoisted(() => ({ mockSummarize: vi.fn() }))
vi.mock('@renderer/hooks/use-sessions', () => ({
  useSummarizeSession: () => ({ mutateAsync: mockSummarize }),
}))

// Mock children so we don't pull in the world; just mark them with testids.
vi.mock('@renderer/components/messages/message-list', () => ({
  MessageList: ({ pendingRequestCount }: { pendingRequestCount?: number }) => (
    <div data-testid="message-list" data-pending-count={pendingRequestCount} />
  ),
}))
// The mocked composer reports a fixed snapshot back through registerSnapshot so the
// Start-fresh handler has live composer state to carry over. Tests can reassign it.
let mockSnapshot: ComposerSnapshot = { text: '', attachments: [], model: 'opus', effort: 'high' }
vi.mock('@renderer/components/messages/message-input', () => ({
  MessageInput: ({ registerSnapshot }: { registerSnapshot?: (g: (() => unknown) | null) => void }) => {
    registerSnapshot?.(() => mockSnapshot)
    return <div data-testid="message-input-mock" />
  },
}))
vi.mock('@renderer/components/messages/agent-activity-indicator', () => ({
  AgentActivityIndicator: () => null,
}))
vi.mock('@renderer/components/messages/pending-request-stack', () => ({
  PendingRequestStack: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pending-request-stack">{children}</div>
  ),
}))
vi.mock('@renderer/components/messages/pending-request-renderer', () => ({
  renderPendingRequest: (d: PendingRequestDescriptor) => (
    <div key={d.key} data-testid={`pending-${d.kind}`} data-key={d.key} />
  ),
}))
// TrayManager pulls in the sidebar/browser world; the composer-swap logic doesn't need it.
vi.mock('@renderer/components/tray/tray-manager', () => ({
  TrayManager: () => null,
}))

// usePendingRequests is the lever this test pulls.
const mockPendingResult = {
  items: [] as PendingRequestDescriptor[],
  count: 0,
}
vi.mock('@renderer/components/messages/use-pending-requests', () => ({
  usePendingRequests: () => mockPendingResult,
}))

// useMessageStream — SessionChatColumn reads `isActive`, `browserActive`, and the
// pending-request arrays. `mockIsActive` is mutable so a test can drive a turn.
let mockIsActive = false
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({
    isActive: mockIsActive,
    browserActive: false,
    isWaitingBackground: false,
    pendingSecretRequests: [],
    pendingConnectedAccountRequests: [],
    pendingQuestionRequests: [],
    pendingFileRequests: [],
    pendingRemoteMcpRequests: [],
    pendingBrowserInputRequests: [],
  }),
}))

const baseProps = {
  sessionId: 's-1',
  agentSlug: 'agent-1',
  pendingUserMessages: [],
  isViewOnly: false,
  contextPercent: null,
  onPendingMessageAppeared: () => {},
  onMessageSent: () => {},
  onMessageUuidAssigned: () => {},
  onMessageFailed: () => {},
}

const noop = () => {}

const secretDescriptor: PendingRequestDescriptor = {
  kind: 'secret',
  key: 'tu-1',
  toolUseId: 'tu-1',
  secretName: 'A',
  onComplete: noop,
}
const fileDescriptor: PendingRequestDescriptor = {
  kind: 'file',
  key: 'tu-2',
  toolUseId: 'tu-2',
  description: 'pick',
  onComplete: noop,
}

beforeEach(() => {
  mockIsActive = false
})

describe('SessionChatColumn composer swap', () => {
  beforeEach(() => {
    mockPendingResult.items = []
    mockPendingResult.count = 0
  })

  it('renders MessageInput when there are no pending requests', () => {
    renderWithProviders(<SessionChatColumn {...baseProps} />)
    expect(screen.getByTestId('message-input-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-request-stack')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pending-request-slot')).not.toBeInTheDocument()
  })

  it('replaces MessageInput with PendingRequestStack when a request is pending', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    expect(screen.queryByTestId('message-input-mock')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-request-slot')).toBeInTheDocument()
    expect(screen.getByTestId('pending-request-stack')).toBeInTheDocument()
    expect(screen.getByTestId('pending-secret')).toBeInTheDocument()
  })

  it('renders multiple descriptors inside the stack in arrival order', () => {
    mockPendingResult.items = [secretDescriptor, fileDescriptor]
    mockPendingResult.count = 2

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    const stack = screen.getByTestId('pending-request-stack')
    const children = stack.querySelectorAll('[data-testid^="pending-"]')
    expect(children).toHaveLength(2)
    expect(children[0].getAttribute('data-key')).toBe('tu-1')
    expect(children[1].getAttribute('data-key')).toBe('tu-2')
  })

  it('forwards pendingRequestCount to MessageList for scroll-trigger purposes', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    expect(screen.getByTestId('message-list').getAttribute('data-pending-count')).toBe('1')
  })

  it('shows the keyboard hint footer only when no request is pending', () => {
    // No pending → footer shown
    renderWithProviders(<SessionChatColumn {...baseProps} />)
    expect(screen.getByText('Send')).toBeInTheDocument()
    expect(screen.getByText('New line')).toBeInTheDocument()
  })

  it('hides the keyboard hint footer when a request is pending', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    expect(screen.queryByText('Send')).not.toBeInTheDocument()
    expect(screen.queryByText('New line')).not.toBeInTheDocument()
  })
})

// Captures the live drafts store so the test can assert what Start fresh wrote.
let probedStore: ReturnType<typeof useDraftsStore> | undefined
function StoreProbe() {
  probedStore = useDraftsStore()
  return null
}

// Idle + large enough to trip the stale-session gate (idle > 6h AND context > 100k).
const staleProps = {
  ...baseProps,
  lastActivityAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
  contextUsage: {
    inputTokens: 5000,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 130_000,
    contextWindow: 200_000,
  } satisfies SessionUsage,
}

describe('SessionChatColumn Start fresh', () => {
  beforeEach(() => {
    mockPendingResult.items = []
    mockPendingResult.count = 0
    probedStore = undefined
    mockSnapshot = { text: '', attachments: [], model: 'opus', effort: 'high' }
  })

  async function clickStartFresh() {
    const user = userEvent.setup()
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    await user.click(await screen.findByTestId('stale-new-chat-fresh'))
  }

  it('carries text + selected model/effort into the agent draft + carry-over, then navigates', async () => {
    mockSnapshot = { text: 'pick this up later', attachments: [], model: 'sonnet', effort: 'low' }
    const onStartFresh = vi.fn()

    renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )

    await clickStartFresh()

    expect(onStartFresh).toHaveBeenCalledTimes(1)
    expect(probedStore?.get('agent:agent-1')).toBe('pick this up later')
    expect(probedStore?.get<NewChatCarryover>(carryoverKey('agent-1'))).toEqual({
      attachments: [],
      model: 'sonnet',
      effort: 'low',
    })
    // Source session draft is cleared — Start fresh is a move, not a copy.
    expect(probedStore?.get('session:s-1')).toBeUndefined()
  })

  it('carries model/effort but leaves the agent draft untouched when the composer is empty', async () => {
    mockSnapshot = { text: '   ', attachments: [], model: 'opus', effort: 'high' }
    const onStartFresh = vi.fn()

    renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )

    await clickStartFresh()

    expect(onStartFresh).toHaveBeenCalledTimes(1)
    // Blank composer must not clobber an existing agent-home draft.
    expect(probedStore?.get('agent:agent-1')).toBeUndefined()
    expect(probedStore?.get<NewChatCarryover>(carryoverKey('agent-1'))).toEqual({
      attachments: [],
      model: 'opus',
      effort: 'high',
    })
  })

  it('clears a previously staged summary so Start fresh lands on a clean composer', async () => {
    const onStartFresh = vi.fn()
    renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )
    // A summary staged by an earlier "Start with Summary" the user navigated away from.
    probedStore?.set(
      summaryKey('agent-1'),
      { summary: 'stale summary', fromSessionId: 'old-session' } satisfies NewChatSummary,
    )

    await clickStartFresh()

    expect(onStartFresh).toHaveBeenCalledTimes(1)
    // Start fresh is the no-summary path: the stale summary must not ride along.
    expect(probedStore?.get(summaryKey('agent-1'))).toBeUndefined()
  })
})

describe('SessionChatColumn Start with Summary', () => {
  beforeEach(() => {
    mockPendingResult.items = []
    mockPendingResult.count = 0
    probedStore = undefined
    mockSnapshot = { text: 'keep going', attachments: [], model: 'opus', effort: 'high' }
    mockSummarize.mockReset()
  })

  async function clickStartSummary() {
    const user = userEvent.setup()
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    await user.click(await screen.findByTestId('stale-new-chat-summary'))
  }

  it('summarizes, stashes summary + carryover, then navigates', async () => {
    mockSummarize.mockResolvedValueOnce({ summary: '## Goal\nFinish auth' })
    const onStartFresh = vi.fn()

    renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )

    await clickStartSummary()

    expect(mockSummarize).toHaveBeenCalledWith({ agentSlug: 'agent-1', fromSessionId: 's-1' })
    expect(onStartFresh).toHaveBeenCalledTimes(1)
    expect(probedStore?.get<NewChatSummary>(summaryKey('agent-1'))).toEqual({
      summary: '## Goal\nFinish auth',
      fromSessionId: 's-1',
    })
    expect(probedStore?.get('agent:agent-1')).toBe('keep going')
    expect(probedStore?.get<NewChatCarryover>(carryoverKey('agent-1'))).toEqual({
      attachments: [],
      model: 'opus',
      effort: 'high',
    })
    expect(probedStore?.get('session:s-1')).toBeUndefined()
  })

  it('stays put and shows an error when summarization fails', async () => {
    mockSummarize.mockRejectedValueOnce(new Error('boom'))
    const onStartFresh = vi.fn()

    renderWithProviders(<SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />)

    await clickStartSummary()

    expect(onStartFresh).not.toHaveBeenCalled()
    expect(await screen.findByText("Couldn't summarize right now")).toBeInTheDocument()
  })

  it('drops the in-flight guard on navigate-away: a late summarize does not stash or navigate', async () => {
    let resolveSummarize: (v: { summary: string }) => void = () => {}
    mockSummarize.mockReturnValueOnce(new Promise((res) => { resolveSummarize = res }))
    const onStartFresh = vi.fn()

    const { unmount } = renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )

    await clickStartSummary() // handler suspends on the pending summarize
    unmount() // user navigates away; the [sessionId] cleanup clears actionActiveRef
    resolveSummarize({ summary: '## Goal\nFinish auth' })
    await new Promise((r) => setTimeout(r, 0)) // flush the post-await continuation

    expect(onStartFresh).not.toHaveBeenCalled()
    expect(probedStore?.get(summaryKey('agent-1'))).toBeUndefined()
    expect(probedStore?.get('agent:agent-1')).toBeUndefined()
  })

  it('failure preserves the source draft and does not write summary or carryover keys', async () => {
    mockSummarize.mockRejectedValueOnce(new Error('boom'))
    const onStartFresh = vi.fn()

    renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )

    // Seed the source draft — failure must leave this untouched
    probedStore!.set('session:s-1', 'do not clear this')

    await clickStartSummary()

    expect(onStartFresh).not.toHaveBeenCalled()
    expect(await screen.findByText("Couldn't summarize right now")).toBeInTheDocument()
    // Loading indicator must be gone (isSummarizing reset)
    expect(screen.queryByTestId('stale-new-chat-summarizing')).not.toBeInTheDocument()
    // Source draft must be preserved — failure is not a move
    expect(probedStore?.get('session:s-1')).toBe('do not clear this')
    // Summary / carryover / agent draft must NOT have been written
    expect(probedStore?.get(summaryKey('agent-1'))).toBeUndefined()
    expect(probedStore?.get('agent:agent-1')).toBeUndefined()
    expect(probedStore?.get(carryoverKey('agent-1'))).toBeUndefined()
  })

  it('retry after a failure succeeds: clears the error, writes the summary key, and navigates', async () => {
    mockSummarize
      .mockRejectedValueOnce(new Error('first attempt fails'))
      .mockResolvedValueOnce({ summary: '## Goal' })
    const onStartFresh = vi.fn()

    renderWithProviders(
      <>
        <SessionChatColumn {...staleProps} onStartFresh={onStartFresh} />
        <StoreProbe />
      </>
    )

    await clickStartSummary() // first attempt — fails

    expect(await screen.findByText("Couldn't summarize right now")).toBeInTheDocument()
    expect(onStartFresh).not.toHaveBeenCalled()

    // Popover is still open; click the inline retry button
    const user = userEvent.setup()
    await user.click(screen.getByTestId('stale-new-chat-retry'))

    // Wait for the async retry to complete and navigate
    await waitFor(() => expect(onStartFresh).toHaveBeenCalledTimes(1))

    // Error must have cleared
    expect(screen.queryByText("Couldn't summarize right now")).not.toBeInTheDocument()
    // Summary key must be written with the summary from the successful retry
    expect(probedStore?.get<NewChatSummary>(summaryKey('agent-1'))).toEqual({
      summary: '## Goal',
      fromSessionId: 's-1',
    })
  })
})

describe('SessionChatColumn stale gate', () => {
  it('does not re-trip immediately after a turn (active -> idle resets the idle clock)', () => {
    const { rerender } = renderWithProviders(<SessionChatColumn {...staleProps} />)
    // Idle + large at rest -> the prompt shows.
    expect(screen.getByTestId('stale-toast')).toBeInTheDocument()

    // A turn starts -> the running session suppresses the prompt.
    mockIsActive = true
    rerender(<SessionChatColumn {...staleProps} />)
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()

    // Turn ends -> the prompt STAYS hidden: the just-finished turn reset the idle
    // clock even though the persisted lastActivityAt is still hours old. Regression
    // guard — it used to immediately re-trip because the gate read only that stale
    // timestamp.
    mockIsActive = false
    rerender(<SessionChatColumn {...staleProps} />)
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()
  })

  it('never shows the stale toast for view-only users (they cannot branch)', () => {
    // Required suppressor: view-only users have no branch action, so the prompt
    // must stay hidden even when the idle + large-context gate is satisfied.
    renderWithProviders(<SessionChatColumn {...staleProps} isViewOnly />)
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()
  })

  it('clears the live active->idle signal on conversation change so an idle sibling still prompts', () => {
    // Conversation A runs a turn then goes idle; the live signal reset A's idle
    // clock, so A's own prompt stays hidden.
    const { rerender } = renderWithProviders(<SessionChatColumn {...staleProps} sessionId="conv-a" />)
    mockIsActive = true
    rerender(<SessionChatColumn {...staleProps} sessionId="conv-a" />)
    mockIsActive = false
    rerender(<SessionChatColumn {...staleProps} sessionId="conv-a" />)
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()

    // A different conversation that is itself idle + large must show the prompt:
    // A's recent activity must not bleed across the persistent holder.
    rerender(<SessionChatColumn {...staleProps} sessionId="conv-b" />)
    expect(screen.getByTestId('stale-toast')).toBeInTheDocument()
  })

  it('clears local Ignore on conversation change (Ignore is per-conversation)', async () => {
    const { rerender } = renderWithProviders(<SessionChatColumn {...staleProps} sessionId="conv-a" />)
    await userEvent.click(screen.getByTestId('stale-toast-ignore'))
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()

    // Switching conversations must not carry the previous one's Ignore.
    rerender(<SessionChatColumn {...staleProps} sessionId="conv-b" />)
    expect(screen.getByTestId('stale-toast')).toBeInTheDocument()
  })
})
