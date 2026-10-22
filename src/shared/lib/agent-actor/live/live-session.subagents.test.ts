/**
 * The subagents a session's turn launches (`Subagents`, through the
 * session): sidechain frames routed away from the main stream, a subagent's
 * own streaming, how its agent id is learned, and how its completion is
 * detected for foreground, background and resumed runs.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import { WorkflowJournalTailer } from '@shared/lib/container/workflow-journal-tailer'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'

const SESSION_ID = 'test-session-1'
const AGENT_SLUG = 'test-agent'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = AGENT_SLUG) => live.sessions(slug)

let mockClient: StreamClient
let sseEvents: any[]
let sseCleanup: () => void

beforeEach(async () => {
  mockClient = createStreamClient()
  await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)

  const sse = live.collect(AGENT_SLUG, SESSION_ID)
  sseEvents = sse.events
  sseCleanup = sse.stop
})

afterEach(() => {
  sseCleanup()
  sessions().unsubscribe(SESSION_ID)
  live.reset()
  vi.clearAllMocks()
})

// ============================================================================
// Sidechain message filtering
// ============================================================================

describe('sidechain message filtering', () => {
  it('filters messages with parent_tool_use_id away from main streaming state', () => {
    // First, trigger a normal assistant message to set some state
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    })

    // Clear SSE events from setup
    sseEvents.length = 0

    // Now send a sidechain message (has parent_tool_use_id)
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'tool-123',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain text' }] },
    })

    // Should broadcast subagent_updated, NOT messages_updated
    const subagentEvents = sseEvents.filter(e => e.type === 'subagent_updated')
    const messagesUpdated = sseEvents.filter(e => e.type === 'messages_updated')
    expect(subagentEvents.length).toBeGreaterThanOrEqual(1)
    expect(messagesUpdated).toHaveLength(0)
  })

  it("learns the subagent's agentId from the frame's agent_id (SDK 0.3.292+)", () => {
    sseEvents.length = 0
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'tool-agent-id',
      agent_id: 'a1b2c3d4e5f6a7b8c',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain text' }] },
    })

    const withAgentId = sseEvents.filter(
      (e) => e.type === 'subagent_updated' && e.parentToolId === 'tool-agent-id' && e.agentId
    )
    expect(withAgentId.length).toBeGreaterThanOrEqual(1)
    expect(withAgentId.every((e) => e.agentId === 'a1b2c3d4e5f6a7b8c')).toBe(true)
  })

  it('does not filter messages without parent_tool_use_id', () => {
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Main text' }] },
    })

    const messagesUpdated = sseEvents.filter(e => e.type === 'messages_updated')
    expect(messagesUpdated).toHaveLength(1)
  })

  it('broadcasts subagent_stream_delta for sidechain stream events (not subagent_updated)', () => {
    // Stream event with parent_tool_use_id — now routes to subagent stream handler
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'tool-123',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'partial' },
      },
    })

    // Should broadcast subagent_stream_delta, NOT subagent_updated
    const streamDelta = sseEvents.filter(e => e.type === 'subagent_stream_delta')
    const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
    expect(streamDelta).toHaveLength(1)
    expect(streamDelta[0].text).toBe('partial')
    expect(subagentUpdated).toHaveLength(0)
  })

  it('broadcasts subagent_updated for sidechain user messages', () => {
    mockClient.emit({
      type: 'user',
      parent_tool_use_id: 'tool-123',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub-tool', content: 'result' }] },
    })

    const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
    expect(subagentUpdated).toHaveLength(1)
  })
})

// ============================================================================
// Task tool tracking
// ============================================================================

describe('Task tool tracking', () => {
  it('sets pendingTaskToolId when Task tool block completes', () => {
    // Start a Task tool_use block
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
      },
    })

    // Stream some input
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"Explore"}' },
      },
    })

    // Complete the block
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    // Now sidechain messages should reference this pending tool
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Sub-agent working' }] },
    })

    const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
    expect(subagentUpdated.length).toBeGreaterThanOrEqual(1)
    expect(subagentUpdated[0].parentToolId).toBe('task-tool-1')
  })

  it('uses parent_tool_use_id as parentToolId for any sidechain message', () => {
    // Start a Bash tool (non-Task)
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'bash-tool-1', name: 'Bash' },
      },
    })

    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    // Sidechain message with parent_tool_use_id should use it as parentToolId
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'some-id',
      message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] },
    })

    const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
    expect(subagentUpdated.length).toBeGreaterThanOrEqual(1)
    expect(subagentUpdated[0].parentToolId).toBe('some-id')
  })
})

// ============================================================================
// Subagent completion detection
// ============================================================================

describe('subagent completion detection', () => {
  it('broadcasts lifecycle events for a background subagent launched inside a Skill', () => {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'skill-tool', name: 'Skill' },
      },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'skill-tool',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'nested-agent-tool', name: 'Agent' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'skill-tool',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'input_json_delta',
          partial_json: '{"subagent_type":"code-reviewer"}',
        },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'skill-tool',
      event: { type: 'content_block_stop' },
    })
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      parent_tool_use_id: 'skill-tool',
      task_id: 'nested-agent-id',
      tool_use_id: 'nested-agent-tool',
      task_type: 'local_agent',
      subagent_type: 'code-reviewer',
      description: 'Review the changes',
    })
    mockClient.emit({
      type: 'user',
      parent_tool_use_id: 'skill-tool',
      tool_use_result: {
        status: 'async_launched',
        isAsync: true,
        agentId: 'nested-agent-id',
      },
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'nested-agent-tool',
          content: 'Agent launched successfully. agentId: nested-agent-id',
        }],
      },
    })
    expect(sessions().backgroundTasks(SESSION_ID)).toEqual([
      expect.objectContaining({
        taskId: 'nested-agent-id',
        isSubagent: true,
      }),
    ])

    mockClient.emit({
      type: 'system',
      subtype: 'task_progress',
      parent_tool_use_id: 'skill-tool',
      task_id: 'nested-agent-id',
      tool_use_id: 'nested-agent-tool',
      subagent_type: 'code-reviewer',
      summary: 'Inspecting tests',
      usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
      last_tool_name: 'Read',
    })
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'nested-agent-tool',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'webhook-tool',
          name: 'mcp__user-input__create_webhook_endpoint',
        },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'nested-agent-tool',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'input_json_delta',
          partial_json: '{"verification":{"secret":"whsec_supersecret","header":"x-sig"}}',
        },
      },
    })
    const activeSubagents = sessions().activeSubagents(SESSION_ID)
    expect(activeSubagents).toEqual([
      expect.objectContaining({
        parentToolId: 'nested-agent-tool',
        agentId: 'nested-agent-id',
        subagentType: 'code-reviewer',
        description: 'Review the changes',
        progressSummary: 'Inspecting tests',
        usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
        lastToolName: 'Read',
        streamingToolUse: expect.objectContaining({
          id: 'webhook-tool',
          name: 'mcp__user-input__create_webhook_endpoint',
        }),
      }),
    ])
    expect(activeSubagents[0].streamingToolUse?.partialInput).not.toContain('whsec_supersecret')
    expect(activeSubagents[0].streamingToolUse?.partialInput).toContain('"secret":"***"')

    mockClient.emit({
      type: 'system',
      subtype: 'task_notification',
      parent_tool_use_id: 'skill-tool',
      task_id: 'nested-agent-id',
      tool_use_id: 'nested-agent-tool',
      status: 'completed',
      summary: 'Review complete',
    })

    expect(sseEvents.filter(e => e.type === 'subagent_started')).toEqual([
      expect.objectContaining({
        parentToolId: 'nested-agent-tool',
        agentId: 'nested-agent-id',
        subagentType: 'code-reviewer',
        description: 'Review the changes',
      }),
    ])
    expect(sseEvents.filter(e => e.type === 'subagent_progress')).toEqual([
      expect.objectContaining({
        parentToolId: 'nested-agent-tool',
        summary: 'Inspecting tests',
      }),
    ])
    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
      expect.objectContaining({
        parentToolId: 'nested-agent-tool',
        agentId: 'nested-agent-id',
        resultText: 'Review complete',
      }),
    ])
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)
    expect(sessions().activeSubagents(SESSION_ID)).toEqual([
      expect.objectContaining({
        parentToolId: 'nested-agent-tool',
        status: 'completed',
      }),
    ])

    sessions().markActive(SESSION_ID)
    expect(sessions().activeSubagents(SESSION_ID)).toHaveLength(0)
  })

  it('completes a foreground subagent from its Skill sidechain tool result', () => {
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'skill-tool',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'foreground-agent-tool',
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'Inspect files' },
        }],
      },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      parent_tool_use_id: 'skill-tool',
      task_id: 'foreground-agent-id',
      tool_use_id: 'foreground-agent-tool',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'Inspect files',
    })
    sseEvents.length = 0

    mockClient.emit({
      type: 'user',
      parent_tool_use_id: 'skill-tool',
      tool_use_result: { status: 'completed', agentId: 'foreground-agent-id' },
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'foreground-agent-tool',
          content: 'Inspection complete',
        }],
      },
    })

    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
      expect.objectContaining({
        parentToolId: 'foreground-agent-tool',
        agentId: 'foreground-agent-id',
        resultText: 'Inspection complete',
      }),
    ])
    expect(sessions().activeSubagents(SESSION_ID)).toEqual([
      expect.objectContaining({
        parentToolId: 'foreground-agent-tool',
        status: 'completed',
      }),
    ])
  })

  it('broadcasts subagent_completed when tool_result matches pendingTaskToolId', async () => {
    // Set up Task tool tracking
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    // task_started sets agentId deterministically
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      tool_use_id: 'task-tool-1',
      description: 'test',
    })

    sseEvents.length = 0

    // Send tool_result for the Task tool (subagent completed)
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].parentToolId).toBe('task-tool-1')
    expect(completed[0].agentId).toBe('sub1')
  })

  // A background subagent (run_in_background Agent) gets only an immediate
  // "async_launched" tool_result; its real completion arrives as a
  // task_notification / task_updated, NOT a second tool_result or a sidechain
  // 'result'. Without handling these the UI shows it running until turn end.
  const startBackgroundSubagent = () => {
    // Stream the Agent tool_use WITH run_in_background so the session marks
    // the subagent isBackground=true (the discriminator the completion handlers
    // gate on — foreground subagents finish via tool_result instead).
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'bg-tool', name: 'Agent' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"general-purpose","run_in_background":true}' } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    mockClient.emit({
      type: 'system', subtype: 'task_started', task_id: 'bgsub', tool_use_id: 'bg-tool',
      subagent_type: 'general-purpose', description: 'Sleep 15 seconds',
    })
    sseEvents.length = 0
  }

  it('completes a background subagent on task_notification (matched by tool_use_id)', () => {
    startBackgroundSubagent()
    mockClient.emit({
      type: 'system', subtype: 'task_notification', task_id: 'bgsub', tool_use_id: 'bg-tool',
      status: 'completed', summary: 'Agent "Sleep 15 seconds" completed',
    })
    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].parentToolId).toBe('bg-tool')
    expect(completed[0].agentId).toBe('bgsub')
  })

  it('completes a background subagent on task_updated (matched by agentId)', () => {
    startBackgroundSubagent()
    mockClient.emit({
      type: 'system', subtype: 'task_updated', task_id: 'bgsub', patch: { status: 'completed' },
    })
    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].parentToolId).toBe('bg-tool')
  })

  it('fires subagent completion exactly once when task_updated is followed by task_notification', () => {
    startBackgroundSubagent()
    // The real capture emits task_updated then task_notification for the same
    // subagent — the second must not double-fire.
    mockClient.emit({
      type: 'system', subtype: 'task_updated', task_id: 'bgsub', patch: { status: 'completed' },
    })
    mockClient.emit({
      type: 'system', subtype: 'task_notification', task_id: 'bgsub', tool_use_id: 'bg-tool', status: 'completed',
    })
    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
  })

  it('does not let a completed background run shadow a resumed run completion', () => {
    startBackgroundSubagent()
    mockClient.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bgsub',
      patch: { status: 'completed' },
    })
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bgsub',
      tool_use_id: 'send-tool',
      task_type: 'local_agent',
      subagent_type: 'general-purpose',
      description: 'Resume background agent',
    })
    mockClient.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bgsub',
      patch: { status: 'completed' },
    })

    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
      expect.objectContaining({
        parentToolId: 'send-tool',
        agentId: 'bgsub',
      }),
    ])
  })

  it('treats a fork launch as background though it carries no run_in_background', () => {
    // CLI 2.1.302+ forks always run in the background; their Agent input
    // names subagent_type "fork" and nothing else marks them.
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'fork-tool', name: 'Agent' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"fork","description":"fork probe","prompt":"echo"}' } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    mockClient.emit({
      type: 'system', subtype: 'task_started', task_id: 'forksub', tool_use_id: 'fork-tool',
      task_type: 'local_agent', subagent_type: 'fork', description: 'fork probe',
    })
    sseEvents.length = 0

    mockClient.emit({
      type: 'system', subtype: 'task_notification', task_id: 'forksub', tool_use_id: 'fork-tool', status: 'completed',
    })
    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
      expect.objectContaining({ parentToolId: 'fork-tool', agentId: 'forksub' }),
    ])
  })

  it('completes an errored background launch instead of treating it as an async ack', () => {
    // The streamed run_in_background input is only a hint. If the launch is
    // rejected before it gets an async_launched result (for example by a
    // capability-review gate), the error tool_result is terminal and must
    // clean up both the subagent entry and its parked child requests.
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'blocked-bg-tool', name: 'Agent' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"general-purpose","run_in_background":true}' } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    userInputRequestManager.register({
      id: 'blocked-bg-child-request',
      kind: 'question',
      scope: { sessionId: SESSION_ID, agentSlug: AGENT_SLUG },
      blocking: true,
      autoApproved: false,
      parentToolUseId: 'blocked-bg-tool',
      payload: { questions: [] },
    })
    sseEvents.length = 0

    try {
      mockClient.emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'blocked-bg-tool',
            content: 'Agent launch blocked by policy',
            is_error: true,
          }],
        },
      })

      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
      expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)
      expect(userInputRequestManager.getOpenRequest(AGENT_SLUG, 'blocked-bg-child-request')).toBeNull()
    } finally {
      userInputRequestManager.resolve(AGENT_SLUG, 'blocked-bg-child-request', 'cancelled')
    }
  })

  it('keeps a SendMessage-resumed subagent running until its task completes', () => {
    // Real Claude Code 2.1.219 order:
    // Agent completes → SendMessage → background_tasks_changed → task_started
    // (same agentId, new SendMessage tool_use_id) → SendMessage ack → terminal task events.
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'agent-tool', name: 'Agent' } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-resumed',
      tool_use_id: 'agent-tool',
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
      description: 'Lifecycle probe',
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: { status: 'completed', agentId: 'agent-resumed' },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'agent-tool', content: 'FIRST_DONE' }],
      },
    })

    sseEvents.length = 0
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'agent-resumed', task_type: 'local_agent', description: 'Lifecycle probe' }],
    })
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-resumed',
      tool_use_id: 'send-tool',
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
      description: 'Lifecycle probe',
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: {
        success: true,
        resumedAgentId: 'agent-resumed',
        message: 'Agent resumed from transcript in the background.',
      },
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'send-tool',
          content: '{"success":true,"resumedAgentId":"agent-resumed"}',
        }],
      },
    })

    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID)).toEqual([
      expect.objectContaining({ taskId: 'agent-resumed', isSubagent: true }),
    ])

    mockClient.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-resumed',
      patch: { status: 'completed' },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-resumed',
      tool_use_id: 'send-tool',
      status: 'completed',
      summary: 'SECOND_DONE',
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toEqual(expect.objectContaining({
      parentToolId: 'send-tool',
      agentId: 'agent-resumed',
    }))
  })

  it('stops a running workflow journal tailer when the session is unsubscribed', () => {
    const stop = vi.spyOn(WorkflowJournalTailer.prototype, 'stop')
    try {
      mockClient.emit({
        type: 'system', subtype: 'task_started', task_type: 'local_workflow',
        task_id: 'wf-unsubscribe', tool_use_id: 'wf-tool-unsubscribe', workflow_name: 'demo',
      })
      mockClient.emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'wf-tool-unsubscribe', content: 'Run ID: wf_unsubscribe' }],
        },
        tool_use_result: {
          status: 'async_launched', taskType: 'local_workflow', taskId: 'wf-unsubscribe', runId: 'wf_unsubscribe',
        },
      })

      expect(stop).not.toHaveBeenCalled()
      sessions().unsubscribe(SESSION_ID)
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      stop.mockRestore()
    }
  })

  // A dynamic workflow (task_type 'local_workflow') must get the same treatment as a
  // backgrounded Bash command: registered as a background task, surfaced via
  // session_waiting_background, and NOT phantom-cleared/finalized when the SDK fires a
  // premature turn-end idle while it is still running. (Synthetic — mirrors the real
  // background-bash-premature-idle capture shape; replace with a real workflow capture
  // fixture when one is available.)
  it('treats a local_workflow as a background task and survives a premature idle', () => {
    sessions().markActive(SESSION_ID)
    // Make session_state_changed the idle authority (matches the container handshake).
    mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
    sseEvents.length = 0

    // Workflow launches mid-turn → registered as a background task. The real runId
    // (wf_…) is NOT the task_id, so workflow_started does NOT fire yet.
    mockClient.emit({
      type: 'system', subtype: 'task_started', task_type: 'local_workflow',
      task_id: 'wf1', tool_use_id: 'wf-tool', workflow_name: 'demo', description: 'demo workflow',
    })
    expect(sseEvents.filter(e => e.type === 'background_task_started' && e.taskId === 'wf1')).toHaveLength(1)
    expect(sseEvents.filter(e => e.type === 'workflow_started')).toHaveLength(0)

    // The Workflow tool result (next message) carries the real on-disk runId → NOW the
    // drawer gets the runId↔tool link + live tailing starts.
    mockClient.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'wf-tool', content: 'Run ID: wf_demo-123', is_error: false }],
      },
      tool_use_result: { status: 'async_launched', taskType: 'local_workflow', taskId: 'wf1', runId: 'wf_demo-123' },
    })
    expect(sseEvents.filter(e => e.type === 'workflow_started' && e.runId === 'wf_demo-123' && e.toolUseId === 'wf-tool' && e.name === 'demo')).toHaveLength(1)

    // A task_progress with a workflow_progress[] snapshot → forwarded as workflow_progress,
    // keyed by the resolved runId, with mapped per-agent state + usage.
    sseEvents.length = 0
    mockClient.emit({
      type: 'system', subtype: 'task_progress', task_id: 'wf1', tool_use_id: 'wf-tool',
      usage: { total_tokens: 100, tool_uses: 2, duration_ms: 5000 },
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'Wait' },
        { type: 'workflow_agent', agentId: 'ag1', label: 'agent-A', phaseTitle: 'Wait', model: 'claude-sonnet-5', promptPreview: 'Wait for the results', state: 'progress', tokens: 50, toolCalls: 1, lastToolName: 'Bash', lastToolSummary: 'sleep 40' },
        { type: 'workflow_agent', agentId: 'ag2', label: 'agent-B', phaseTitle: 'Wait', state: 'done', tokens: 60, toolCalls: 0 },
      ],
    })
    const wp = sseEvents.filter(e => e.type === 'workflow_progress' && e.runId === 'wf_demo-123')
    expect(wp).toHaveLength(1)
    expect(wp[0].usage).toEqual({ totalTokens: 100, toolUses: 2, durationMs: 5000 })
    expect(wp[0].agents).toHaveLength(2) // phase entries filtered out
    expect(wp[0].agents[0]).toMatchObject({ agentId: 'ag1', label: 'agent-A', phase: 'Wait', model: 'claude-sonnet-5', prompt: 'Wait for the results', state: 'progress', tokens: 50, toolCalls: 1, lastTool: 'sleep 40' })
    expect(wp[0].agents[1]).toMatchObject({ agentId: 'ag2', state: 'done', lastTool: null })

    // Launch turn ends, but the workflow keeps running in the background.
    mockClient.emit({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(sseEvents.some(e => e.type === 'session_waiting_background')).toBe(true)

    // Premature idle while the workflow is still running → must stay waiting-background.
    sseEvents.length = 0
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.some(e => e.type === 'session_idle')).toBe(false)
    expect(sseEvents.some(e => e.type === 'background_task_completed')).toBe(false)
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // Workflow settles → its terminal clears the background task exactly once.
    mockClient.emit({
      type: 'system', subtype: 'task_notification', task_id: 'wf1', tool_use_id: 'wf-tool', status: 'completed',
    })
    expect(sseEvents.filter(e => e.type === 'background_task_completed' && e.taskId === 'wf1')).toHaveLength(1)
    // …and the workflow-specific terminal (keyed by the real runId) so the drawer marks it done.
    expect(sseEvents.filter(e => e.type === 'workflow_completed' && e.runId === 'wf_demo-123')).toHaveLength(1)

    // The subsequent, truly-settled idle finalizes the session.
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.some(e => e.type === 'session_idle')).toBe(true)
  })

  it('does not broadcast subagent_completed for non-matching tool_result', () => {
    // Set up Task tool tracking
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    sseEvents.length = 0

    // Send tool_result for a different tool
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'other-tool', content: 'result' }],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(0)
  })

  it('clears pendingTaskToolId after subagent completion', () => {
    // Set up and complete first Task tool
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
      },
    })

    sseEvents.length = 0

    // Another tool_result should NOT trigger subagent_completed
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'duplicate' }],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(0)
  })
})

// ============================================================================
// State cleanup on interrupt/inactive
// ============================================================================

describe('state cleanup', () => {
  it('clears subagent state on markSessionInterrupted', async () => {
    // Set up Task tool tracking
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    sseEvents.length = 0

    // Interrupt the session
    sessions().markInterrupted(SESSION_ID)

    // Now tool_result should NOT trigger subagent_completed since state was cleared
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(0)
  })

  it('clears subagent state when session goes inactive via result event', () => {
    // Set up Task tool tracking
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    // Mark session active first
    sessions().markActive(SESSION_ID)

    sseEvents.length = 0

    // Session completes via result event
    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })

    // Verify session_idle was broadcast
    const idle = sseEvents.filter(e => e.type === 'session_idle')
    expect(idle.length).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// Subagent ID discovery
// ============================================================================

describe('subagent ID resolution (deterministic via task_started)', () => {
  function setupTaskTool(toolId = 'task-tool-1') {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('resolves agentId from task_started.task_id', () => {
    setupTaskTool('task-tool-1')

    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'abc123',
      tool_use_id: 'task-tool-1',
      subagent_type: 'web-browser',
      description: 'Browse the web',
    })

    const started = sseEvents.filter(e => e.type === 'subagent_started')
    expect(started).toHaveLength(1)
    expect(started[0].agentId).toBe('abc123')
    expect(started[0].parentToolId).toBe('task-tool-1')
    expect(started[0].subagentType).toBe('web-browser')
  })

  it('resolves multiple parallel subagents deterministically', () => {
    setupTaskTool('tool-A')
    setupTaskTool('tool-B')

    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'abc123',
      tool_use_id: 'tool-A',
      description: 'First',
    })
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'def456',
      tool_use_id: 'tool-B',
      description: 'Second',
    })

    const started = sseEvents.filter(e => e.type === 'subagent_started')
    expect(started).toHaveLength(2)
    expect(started[0].agentId).toBe('abc123')
    expect(started[0].parentToolId).toBe('tool-A')
    expect(started[1].agentId).toBe('def456')
    expect(started[1].parentToolId).toBe('tool-B')
  })

  it('agentId from sidechain message updates entry without filesystem', () => {
    const listDir = vi.spyOn(live.store(AGENT_SLUG).files, 'list')
    setupTaskTool('task-tool-1')
    sseEvents.length = 0

    // Sidechain message arrives before task_started, with agentId on the message
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      agentId: 'direct-id-123',
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    })

    const updated = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'direct-id-123')
    expect(updated.length).toBeGreaterThanOrEqual(1)
    expect(listDir).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Subagent streaming
// ============================================================================

describe('subagent streaming', () => {
  // Helper: set up a Task tool so parentToolId is tracked
  function setupTaskTool(toolId = 'task-tool-1') {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  // Helper: send a sidechain stream event
  function sendSidechainStreamEvent(event: any) {
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'task-tool-1',
      event,
    })
  }

  it('broadcasts subagent_stream_start on sidechain message_start', () => {
    setupTaskTool()
    sseEvents.length = 0

    sendSidechainStreamEvent({ type: 'message_start' })

    const starts = sseEvents.filter(e => e.type === 'subagent_stream_start')
    expect(starts).toHaveLength(1)
    expect(starts[0].parentToolId).toBe('task-tool-1')
  })

  it('broadcasts subagent_stream_delta for text deltas and accumulates text', () => {
    setupTaskTool()
    sseEvents.length = 0

    sendSidechainStreamEvent({ type: 'message_start' })
    sendSidechainStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello ' },
    })
    sendSidechainStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'world' },
    })

    const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0].text).toBe('Hello ')
    expect(deltas[1].text).toBe('world')
  })

  it('broadcasts subagent_tool_use_start and subagent_tool_use_streaming for tool use', () => {
    setupTaskTool()
    sseEvents.length = 0

    sendSidechainStreamEvent({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'sub-tool-1', name: 'Bash' },
    })
    sendSidechainStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
    })
    sendSidechainStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '"ls"}' },
    })

    const starts = sseEvents.filter(e => e.type === 'subagent_tool_use_start')
    expect(starts).toHaveLength(1)
    expect(starts[0].toolName).toBe('Bash')
    expect(starts[0].toolId).toBe('sub-tool-1')

    const streaming = sseEvents.filter(e => e.type === 'subagent_tool_use_streaming')
    expect(streaming).toHaveLength(2)
    // Input accumulates
    expect(streaming[0].partialInput).toBe('{"cmd":')
    expect(streaming[1].partialInput).toBe('{"cmd":"ls"}')
  })

  it('broadcasts subagent_tool_use_ready on content_block_stop for tool use', () => {
    setupTaskTool()
    sseEvents.length = 0

    sendSidechainStreamEvent({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'sub-tool-1', name: 'Read' },
    })
    sendSidechainStreamEvent({ type: 'content_block_stop' })

    const ready = sseEvents.filter(e => e.type === 'subagent_tool_use_ready')
    expect(ready).toHaveLength(1)
    expect(ready[0].toolId).toBe('sub-tool-1')
    expect(ready[0].toolName).toBe('Read')
  })

  it('does NOT corrupt main agent streaming state with sidechain events', () => {
    // Start main agent streaming
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Main text' },
      },
    })

    sseEvents.length = 0

    // Now send sidechain text delta
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'tool-123',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Sub text' },
      },
    })

    // Main agent should still get its own stream_delta, not subagent's
    // And subagent should get subagent_stream_delta
    const mainDeltas = sseEvents.filter(e => e.type === 'stream_delta')
    const subDeltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
    expect(mainDeltas).toHaveLength(0) // No main delta from this sidechain event
    expect(subDeltas).toHaveLength(1)
    expect(subDeltas[0].text).toBe('Sub text')
  })

  it('clears subagent streaming text when complete assistant message arrives', () => {
    setupTaskTool()
    sseEvents.length = 0

    // Stream some subagent text
    sendSidechainStreamEvent({ type: 'message_start' })
    sendSidechainStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Streaming...' },
    })

    // Now a complete assistant message arrives (persisted)
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Full response' }] },
    })

    // The subagent_updated event should be broadcast (for the complete message)
    const updated = sseEvents.filter(e => e.type === 'subagent_updated')
    expect(updated).toHaveLength(1)
  })

  it('clears subagent streaming state on subagent completion', async () => {
    setupTaskTool()

    // task_started sets agentId deterministically
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      tool_use_id: 'task-tool-1',
      description: 'test',
    })

    // Stream some subagent content
    sendSidechainStreamEvent({ type: 'message_start' })
    sendSidechainStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Working...' },
    })

    sseEvents.length = 0

    // Subagent completes via tool_result for the Task tool
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].agentId).toBe('sub1')

    // Subsequent sidechain stream events should start fresh
    sseEvents.length = 0
    // Set up a new task tool since the old one was cleared
    setupTaskTool('task-tool-2')
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'task-tool-2',
      event: { type: 'message_start' },
    })

    const starts = sseEvents.filter(e => e.type === 'subagent_stream_start')
    expect(starts).toHaveLength(1)
  })

  it('sequential subagents each get their own agentId from task_started', () => {
    // First subagent
    setupTaskTool('task-tool-1')
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      tool_use_id: 'task-tool-1',
      description: 'first',
    })

    // Complete the first subagent
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
      },
    })

    sseEvents.length = 0

    // Second subagent — gets its own agentId, no risk of reusing sub1
    setupTaskTool('task-tool-2')
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub2',
      tool_use_id: 'task-tool-2',
      description: 'second',
    })

    const started = sseEvents.filter(e => e.type === 'subagent_started')
    expect(started).toHaveLength(1)
    expect(started[0].agentId).toBe('sub2')
    expect(started[0].parentToolId).toBe('task-tool-2')
  })

  it('extracts agentId directly from complete sidechain messages', async () => {
    const listDir = vi.spyOn(live.store(AGENT_SLUG).files, 'list')
    setupTaskTool('task-tool-1')
    sseEvents.length = 0

    // Send a complete assistant message with agentId field (as written by SDK)
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      agentId: 'direct-id-123',
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    })

    // Should use the agentId from the message directly, without filesystem discovery
    const updated = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'direct-id-123')
    expect(updated.length).toBeGreaterThanOrEqual(1)
    // Filesystem should NOT have been called
    expect(listDir).not.toHaveBeenCalled()
  })

  it('handles bare events (without stream_event wrapper) as sidechain stream events', () => {
    setupTaskTool()
    sseEvents.length = 0

    // Bare event with parent_tool_use_id (no type: 'stream_event' wrapper)
    mockClient.emit({
      parent_tool_use_id: 'task-tool-1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'bare event text' },
      },
    })

    const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe('bare event text')
  })
})

// ============================================================================
// Sidechain complete assistant message broadcasts subagent_stream_delta
// ============================================================================

describe('sidechain complete assistant message text extraction', () => {
  function setupTaskTool(toolId = 'task-tool-1') {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('broadcasts subagent_stream_delta for sidechain complete assistant message with text blocks', () => {
    setupTaskTool()
    sseEvents.length = 0

    // Send a complete assistant message (not streamed) with text content
    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the analysis result.' },
        ],
      },
    })

    // Should broadcast subagent_stream_delta with the extracted text
    const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(deltas[0].text).toBe('Here is the analysis result.')
    expect(deltas[0].parentToolId).toBe('task-tool-1')
  })

  it('extracts and concatenates multiple text blocks from complete assistant message', () => {
    setupTaskTool()
    sseEvents.length = 0

    mockClient.emit({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'tool_use', id: 'sub-tool', name: 'Bash', input: {} },
          { type: 'text', text: 'Part two.' },
        ],
      },
    })

    const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    // The full concatenated text includes both text blocks
    const allText = deltas.map(d => d.text).join('')
    expect(allText).toBe('Part one. Part two.')
  })
})

// ============================================================================
// Subagent completion includes resultText
// ============================================================================

describe('subagent completion resultText', () => {
  function setupTaskTool(toolId = 'task-tool-1') {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: 'Task' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('includes resultText in subagent_completed SSE event from tool_result string content', () => {
    setupTaskTool()
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      tool_use_id: 'task-tool-1',
      description: 'test',
    })

    sseEvents.length = 0

    // Send tool_result with string content (the exit summary)
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'task-tool-1', content: 'All tasks completed successfully.' },
        ],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].resultText).toBe('All tasks completed successfully.')
  })

  it('includes resultText in subagent_completed from tool_result array content', () => {
    setupTaskTool()
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      tool_use_id: 'task-tool-1',
      description: 'test',
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'task-tool-1',
            content: [
              { type: 'text', text: 'First part. ' },
              { type: 'text', text: 'Second part.' },
            ],
          },
        ],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].resultText).toBe('First part. Second part.')
  })

  it('omits resultText when tool_result has no text content', () => {
    setupTaskTool()
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      tool_use_id: 'task-tool-1',
      description: 'test',
    })

    sseEvents.length = 0

    // tool_result with no content
    mockClient.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'task-tool-1' },
        ],
      },
    })

    const completed = sseEvents.filter(e => e.type === 'subagent_completed')
    expect(completed).toHaveLength(1)
    // resultText should not be set (spread is conditional on truthy value)
    expect(completed[0].resultText).toBeUndefined()
  })
})
