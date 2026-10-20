import { describe, expect, it } from 'vitest'
import type { SessionEvent } from './session-channel'
import { Subagents } from './subagents'

/**
 * Subagents over a sink that records what clients heard, which agents were
 * registered as background tasks, and which runs ended. `backgroundAgents`
 * stands in for the background tasks' level set.
 */
function tracked() {
  const events: SessionEvent[] = []
  const registered: Array<[agentId: string, toolUseId: string]> = []
  const ended: string[] = []
  const backgroundAgents = new Set<string>()
  const subagents = new Subagents({
    emit: (event) => events.push(event),
    registerBackground: (agentId, toolUseId) => registered.push([agentId, toolUseId]),
    isBackgroundSubagent: (agentId) => backgroundAgents.has(agentId),
    ended: (parentToolId) => ended.push(parentToolId),
  })
  return {
    subagents,
    events,
    registered,
    ended,
    backgroundAgents,
    types: () => events.map((e) => e.type),
    reset: () => {
      events.length = 0
      registered.length = 0
      ended.length = 0
    },
  }
}

const toolResult = (toolUseId: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content,
  ...extra,
})
const userFrame = (blocks: unknown[], toolUseResult?: unknown) => ({ message: { content: blocks }, tool_use_result: toolUseResult })

/** A foreground subagent launched by `toolu_1` and started as agent `a1`. */
function startedForeground() {
  const t = tracked()
  t.subagents.trackLaunch('toolu_1', '{"description":"Research","prompt":"go"}')
  t.subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent', subagent_type: 'researcher', description: 'Research' })
  t.reset()
  return t
}

/** A background subagent launched by `toolu_1` and started as agent `a1`. */
function startedBackground() {
  const t = tracked()
  t.subagents.trackLaunch('toolu_1', '{"run_in_background":true}')
  t.subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent', is_backgrounded: true })
  t.reset()
  return t
}

describe('Subagents', () => {
  describe('launches', () => {
    it('tracks a launch as foreground unless its input asks for the background', () => {
      const { subagents } = tracked()

      subagents.trackLaunch('toolu_fg', '{"prompt":"x"}')
      subagents.trackLaunch('toolu_bg', '{"run_in_background":true}')
      subagents.trackLaunch('toolu_obj', { run_in_background: true })
      subagents.trackLaunch('toolu_bad', '{"run_in_backgr')

      expect(subagents.size).toBe(4)
      expect(subagents.isSparedFrame('toolu_fg')).toBe(false)
      expect(subagents.isSparedFrame('toolu_bg')).toBe(true)
      expect(subagents.isSparedFrame('toolu_obj')).toBe(true)
      expect(subagents.isSparedFrame('toolu_bad')).toBe(false)
    })

    it('upgrades a known launch to the background, never back', () => {
      const { subagents } = tracked()
      subagents.trackLaunch('toolu_1', '{}')

      subagents.trackLaunch('toolu_1', '{"run_in_background":true}')
      subagents.trackLaunch('toolu_1', '{}')

      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
    })

    it('leaves a launch out of the snapshot until it has an agent id or a type', () => {
      const { subagents } = tracked()

      subagents.trackLaunch('toolu_1', '{}')

      expect(subagents.snapshot()).toEqual([])
    })
  })

  describe('task_started', () => {
    it('names the launch\'s agent and tells clients', () => {
      const { subagents, events } = tracked()
      subagents.trackLaunch('toolu_1', '{}')

      subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent', subagent_type: 'researcher', description: 'Research' })

      expect(events).toEqual([
        { type: 'subagent_started', parentToolId: 'toolu_1', taskId: 'a1', agentId: 'a1', subagentType: 'researcher', description: 'Research' },
      ])
      expect(subagents.snapshot()).toEqual([
        {
          parentToolId: 'toolu_1',
          agentId: 'a1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: null,
          subagentType: 'researcher',
          description: 'Research',
          usage: null,
          lastToolName: null,
          status: 'running',
        },
      ])
    })

    it('creates the entry when it beat the launch', () => {
      const { subagents } = tracked()

      subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent' })

      expect(subagents.snapshot().map((s) => [s.parentToolId, s.agentId])).toEqual([['toolu_1', 'a1']])
    })

    it('registers a backgrounded run as a background task', () => {
      const { subagents, registered } = tracked()
      subagents.trackLaunch('toolu_1', '{}')

      subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent', is_backgrounded: true })

      expect(registered).toEqual([['a1', 'toolu_1']])
      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
    })

    it('recognises background work the level set already lists, on a host that saw no launch ack', () => {
      const { subagents, registered, backgroundAgents } = tracked()
      backgroundAgents.add('a1')

      subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent' })

      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
      expect(registered).toEqual([['a1', 'toolu_1']])
    })

    it('ignores a subagent\'s own inner Bash surfacing on the parent stream', () => {
      const { subagents, events } = tracked()

      subagents.taskStarted({ tool_use_id: 'toolu_bash', task_id: 'b1', task_type: 'local_bash' })

      expect(subagents.size).toBe(0)
      expect(events).toEqual([])
    })

    it('ignores a task_started that names no launching call', () => {
      const { subagents, events } = tracked()

      subagents.taskStarted({ task_id: 'a1', task_type: 'local_agent' })

      expect(subagents.size).toBe(0)
      expect(events).toEqual([])
    })

    it('marks a new run of an agent that already finished as resumed, and tracks it as background work', () => {
      const { subagents, registered, reset } = startedForeground()
      subagents.toolResults(userFrame([toolResult('toolu_1', 'done')]))
      reset()

      subagents.taskStarted({ tool_use_id: 'toolu_send', task_id: 'a1', task_type: 'local_agent' })

      expect(subagents.isSparedFrame('toolu_send')).toBe(true)
      expect(registered).toEqual([['a1', 'toolu_send']])
    })

    it('reopens a finished entry for a new run under the same launching call, so that run reports its completion', () => {
      const { subagents, types, reset } = startedForeground()
      subagents.toolResults(userFrame([toolResult('toolu_1', 'first run')]))
      reset()

      subagents.taskStarted({ tool_use_id: 'toolu_1', task_id: 'a1', task_type: 'local_agent' })
      expect(subagents.snapshot()[0].status).toBe('running')

      subagents.taskNotification('toolu_1', 'completed', 'second run')
      expect(types()).toEqual(['subagent_started', 'subagent_updated', 'subagent_completed'])
    })

    it('remembers finished agents across turns: a later run is still a resume', () => {
      const { subagents } = startedForeground()
      subagents.toolResults(userFrame([toolResult('toolu_1', 'done')]))

      subagents.clear()
      subagents.taskStarted({ tool_use_id: 'toolu_send', task_id: 'a1', task_type: 'local_agent' })

      expect(subagents.isSparedFrame('toolu_send')).toBe(true)
    })
  })

  describe('task_progress', () => {
    it('records usage and the latest summary, keeping the original description', () => {
      const { subagents, events } = startedForeground()
      const usage = { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 }

      subagents.taskProgress({
        tool_use_id: 'toolu_1',
        task_id: 'a1',
        summary: 'Reading files',
        subagent_type: 'explorer',
        usage,
        last_tool_name: 'Read',
      })

      expect(subagents.snapshot()[0]).toMatchObject({
        progressSummary: 'Reading files',
        subagentType: 'explorer',
        description: 'Research',
        usage,
        lastToolName: 'Read',
      })
      expect(events).toEqual([
        { type: 'subagent_progress', parentToolId: 'toolu_1', agentId: 'a1', summary: 'Reading files', subagentType: 'explorer', usage, lastToolName: 'Read' },
      ])
    })

    it('still tells clients about progress for a subagent it is not tracking', () => {
      const { subagents, types } = tracked()

      subagents.taskProgress({ tool_use_id: 'toolu_unknown', task_id: 'a9', summary: 'x' })

      expect(types()).toEqual(['subagent_progress'])
      expect(subagents.size).toBe(0)
    })
  })

  describe('completion', () => {
    it('completes a foreground run through its tool result, with the result text', () => {
      const { subagents, events, ended } = startedForeground()

      subagents.toolResults(userFrame([toolResult('toolu_1', [{ type: 'text', text: 'Found ' }, { type: 'image' }, { type: 'text', text: 'it' }])]))

      expect(events).toEqual([
        { type: 'subagent_updated', parentToolId: 'toolu_1', agentId: 'a1' },
        { type: 'subagent_completed', parentToolId: 'toolu_1', agentId: 'a1', resultText: 'Found it' },
      ])
      expect(ended).toEqual(['toolu_1'])
      expect(subagents.snapshot()[0].status).toBe('completed')
    })

    it('completes a run once', () => {
      const { subagents, types, ended } = startedForeground()

      subagents.complete('toolu_1', 'done')
      subagents.complete('toolu_1', 'done again')
      subagents.toolResults(userFrame([toolResult('toolu_1', 'late')]))

      expect(types()).toEqual(['subagent_updated', 'subagent_completed'])
      expect(ended).toEqual(['toolu_1'])
    })

    it('leaves the result text out when there is none', () => {
      const { subagents, events } = startedForeground()

      subagents.complete('toolu_1')

      expect(events.at(-1)).toEqual({ type: 'subagent_completed', parentToolId: 'toolu_1', agentId: 'a1' })
    })

    it('takes an async launch ack as a background launch, not a completion', () => {
      const { subagents, types, registered, ended } = startedForeground()

      subagents.toolResults(userFrame([toolResult('toolu_1', 'Launched')], { status: 'async_launched', agentId: 'a1' }))

      expect(types()).toEqual([])
      expect(ended).toEqual([])
      expect(registered).toEqual([['a1', 'toolu_1']])
      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
    })

    it('takes an isAsync result as a launch ack too', () => {
      const { subagents, types } = startedForeground()

      subagents.toolResults(userFrame([toolResult('toolu_1', 'Launched')], { isAsync: true }))

      expect(types()).toEqual([])
      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
    })

    it('completes an async launch that errored', () => {
      const { subagents, types } = startedForeground()

      subagents.toolResults(userFrame([toolResult('toolu_1', 'Could not launch', { is_error: true })], { status: 'async_launched' }))

      expect(types()).toEqual(['subagent_updated', 'subagent_completed'])
    })

    it('takes a resume ack as a resumed run, tracked under the resumed agent', () => {
      const { subagents, registered, types } = tracked()
      subagents.trackLaunch('toolu_send', '{}')

      subagents.toolResults(userFrame([toolResult('toolu_send', 'Resumed')], { resumedAgentId: 'a1' }))

      expect(types()).toEqual([])
      expect(registered).toEqual([['a1', 'toolu_send']])
      expect(subagents.isSparedFrame('toolu_send')).toBe(true)
      expect(subagents.snapshot()[0].agentId).toBe('a1')
    })

    it('learns the agent id from the result text when the structured result has none', () => {
      const { subagents } = tracked()
      subagents.trackLaunch('toolu_1', '{}')

      subagents.toolResults(userFrame([toolResult('toolu_1', [{ type: 'text', text: 'Done.\nagentId: abc123 (for resuming)' }])]))

      expect(subagents.snapshot()[0].agentId).toBe('abc123')
    })

    it('ignores results for calls it is not tracking', () => {
      const { subagents, events } = startedForeground()

      subagents.toolResults(userFrame([toolResult('toolu_other', 'x'), { type: 'text', text: 'hi' }]))
      subagents.toolResults({ message: { content: 'not blocks' } })

      expect(events).toEqual([])
      expect(subagents.snapshot()[0].status).toBe('running')
    })

    it('completes a background run through its terminal task notification, with its summary', () => {
      const { subagents, events } = startedBackground()

      subagents.taskNotification('toolu_1', 'running', 'not yet')
      expect(events).toEqual([])

      subagents.taskNotification('toolu_1', 'completed', 'All done')
      expect(events.at(-1)).toEqual({ type: 'subagent_completed', parentToolId: 'toolu_1', agentId: 'a1', resultText: 'All done' })
    })

    it('does not complete a foreground run through a task notification', () => {
      const { subagents, events } = startedForeground()

      subagents.taskNotification('toolu_1', 'completed', 'summary')

      expect(events).toEqual([])
    })

    it('completes a background run through a terminal task_updated for its agent', () => {
      const { subagents, types, ended } = startedBackground()

      subagents.taskEnded('a1')

      expect(types()).toEqual(['subagent_updated', 'subagent_completed'])
      expect(ended).toEqual(['toolu_1'])
    })

    it('does not complete a foreground run through task_updated', () => {
      const { subagents, events } = startedForeground()

      subagents.taskEnded('a1')

      expect(events).toEqual([])
    })
  })

  describe('the level set', () => {
    it('marks the agents it lists as background', () => {
      const { subagents } = startedForeground()

      subagents.markBackground(['a1', 'a-other'])

      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
    })
  })

  describe('a stopped turn', () => {
    it('drops foreground subagents and keeps background and resumed ones', () => {
      const { subagents } = tracked()
      subagents.trackLaunch('toolu_fg', '{}')
      subagents.trackLaunch('toolu_bg', '{"run_in_background":true}')
      subagents.toolResults(userFrame([toolResult('toolu_fg', 'x')]))
      subagents.taskStarted({ tool_use_id: 'toolu_fg2', task_id: 'a2', task_type: 'local_agent' })
      subagents.taskStarted({ tool_use_id: 'toolu_resumed', task_id: 'fresh', task_type: 'local_agent' })
      subagents.toolResults(userFrame([toolResult('toolu_resumed', 'Resumed')], { resumedAgentId: 'fresh' }))

      subagents.dropForeground()

      expect(subagents.size).toBe(2)
      expect(subagents.isSparedFrame('toolu_bg')).toBe(true)
      expect(subagents.isSparedFrame('toolu_resumed')).toBe(true)
      expect(subagents.isSparedFrame('toolu_fg')).toBe(false)
      expect(subagents.isSparedFrame('toolu_fg2')).toBe(false)
    })

    it('spares no frame that names no launching call', () => {
      const { subagents } = startedBackground()

      expect(subagents.isSparedFrame(undefined)).toBe(false)
      expect(subagents.isSparedFrame(42)).toBe(false)
      expect(subagents.isSparedFrame('toolu_unknown')).toBe(false)
    })

    it('forgets every subagent at a new turn', () => {
      const { subagents } = startedBackground()

      subagents.clear()

      expect(subagents.size).toBe(0)
      expect(subagents.snapshot()).toEqual([])
    })
  })

  describe('routing a sidechain frame', () => {
    it('routes a frame to the call that launched its agent', () => {
      const { subagents } = startedForeground()

      expect(subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agent_id: 'a1' })).toBe('toolu_1')
    })

    it('creates the entry when the frame beat the launch, and learns its agent once', () => {
      const { subagents, events } = tracked()

      subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agent_id: 'a1' })
      subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agent_id: 'a1' })

      expect(subagents.snapshot().map((s) => s.agentId)).toEqual(['a1'])
      expect(events).toEqual([{ type: 'subagent_updated', parentToolId: 'toolu_1', agentId: 'a1' }])
    })

    it('reads the transcript\'s agentId spelling too', () => {
      const { subagents } = tracked()
      subagents.trackLaunch('toolu_1', '{}')

      subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agentId: 'a1' })

      expect(subagents.snapshot()[0].agentId).toBe('a1')
    })

    it('recovers the background flag on a reattach that replayed only the level set', () => {
      const { subagents, backgroundAgents } = startedForeground()
      backgroundAgents.add('a1')

      subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agent_id: 'a1' })

      expect(subagents.isSparedFrame('toolu_1')).toBe(true)
    })

    it('routes a SendMessage-resumed run\'s frames to that run, though they name the first launch', () => {
      const { subagents } = startedForeground()
      subagents.toolResults(userFrame([toolResult('toolu_1', 'first run done')]))
      subagents.taskStarted({ tool_use_id: 'toolu_send', task_id: 'a1', task_type: 'local_agent' })

      expect(subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agent_id: 'a1' })).toBe('toolu_send')
    })

    it('keeps a frame on the call it names when no other live run is that agent\'s', () => {
      const { subagents } = startedForeground()
      subagents.complete('toolu_1')

      expect(subagents.routeFrame({ parent_tool_use_id: 'toolu_1', agent_id: 'a1' })).toBe('toolu_1')
      expect(subagents.routeFrame({ parent_tool_use_id: 'toolu_1' })).toBe('toolu_1')
    })
  })

  describe('a subagent\'s stream', () => {
    it('streams its text, tool calls and their input into its card', () => {
      const { subagents, events } = startedForeground()

      subagents.streamEvent('toolu_1', { type: 'message_start' })
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looking' } })
      subagents.streamEvent('toolu_1', { type: 'content_block_start', content_block: { type: 'tool_use', id: 'inner_1', name: 'Read' } })
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file' } })

      expect(events).toEqual([
        { type: 'subagent_stream_start', parentToolId: 'toolu_1', agentId: 'a1' },
        { type: 'subagent_stream_delta', parentToolId: 'toolu_1', agentId: 'a1', text: 'Looking' },
        { type: 'subagent_tool_use_start', parentToolId: 'toolu_1', agentId: 'a1', toolId: 'inner_1', toolName: 'Read', partialInput: '' },
        { type: 'subagent_tool_use_streaming', parentToolId: 'toolu_1', agentId: 'a1', toolId: 'inner_1', toolName: 'Read', partialInput: '{"file' },
      ])
      expect(subagents.snapshot()[0]).toMatchObject({
        streamingMessage: 'Looking',
        streamingToolUse: { id: 'inner_1', name: 'Read', partialInput: '{"file' },
      })
    })

    it('masks a secret in a streamed tool input, live and in the snapshot', () => {
      const { subagents, events } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_start', content_block: { type: 'tool_use', id: 'inner_1', name: 'mcp__user-input__update_webhook_endpoint' } })

      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"secret":"hunter2"}' } })

      expect(events.at(-1)?.partialInput).toBe('{"secret":"***"}')
      expect(subagents.snapshot()[0].streamingToolUse?.partialInput).toBe('{"secret":"***"}')
    })

    it('returns the finished call, with its raw input, at its block stop', () => {
      const { subagents } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_start', content_block: { type: 'tool_use', id: 'inner_1', name: 'Bash' } })
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } })

      expect(subagents.streamEvent('toolu_1', { type: 'content_block_stop' })).toEqual({ id: 'inner_1', name: 'Bash', input: '{"command":"ls"}' })
    })

    it('returns nothing at the stop of a text block', () => {
      const { subagents } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } })

      expect(subagents.streamEvent('toolu_1', { type: 'content_block_stop' })).toBeNull()
    })

    it('stops the inner card streaming once the call has been acted on', () => {
      const { subagents, events } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_start', content_block: { type: 'tool_use', id: 'inner_1', name: 'Bash' } })
      events.length = 0

      subagents.toolUseReady('toolu_1')
      subagents.toolUseReady('toolu_1')

      expect(events).toEqual([{ type: 'subagent_tool_use_ready', parentToolId: 'toolu_1', agentId: 'a1', toolId: 'inner_1', toolName: 'Bash' }])
      expect(subagents.snapshot()[0].streamingToolUse).toBeNull()
    })

    it('drops the call being written when the message stops, and starts the text over with the next one', () => {
      const { subagents } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'old' } })
      subagents.streamEvent('toolu_1', { type: 'content_block_start', content_block: { type: 'tool_use', id: 'inner_1', name: 'Bash' } })

      subagents.streamEvent('toolu_1', { type: 'message_stop' })
      expect(subagents.snapshot()[0].streamingToolUse).toBeNull()

      subagents.streamEvent('toolu_1', { type: 'message_start' })
      expect(subagents.snapshot()[0].streamingMessage).toBeNull()
    })

    it('ignores stream events for a subagent it is not tracking', () => {
      const { subagents, events } = tracked()

      expect(subagents.streamEvent('toolu_unknown', { type: 'message_start' })).toBeNull()

      expect(events).toEqual([])
    })
  })

  describe('a subagent\'s complete message', () => {
    it('sends text that never streamed as a delta, and returns the calls it made', () => {
      const { subagents, events } = startedForeground()

      const calls = subagents.assistantMessage('toolu_1', {
        message: { content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'inner_1', name: 'Read', input: { file_path: '/a' } }] },
      })

      expect(calls).toEqual([{ id: 'inner_1', name: 'Read', input: '{"file_path":"/a"}' }])
      expect(events).toEqual([{ type: 'subagent_stream_delta', parentToolId: 'toolu_1', agentId: 'a1', text: 'Reading.' }])
      expect(subagents.snapshot()[0].streamingMessage).toBe('Reading.')
    })

    it('starts the card\'s text over when the message does not continue what streamed', () => {
      const { subagents, events } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Earlier message' } })
      events.length = 0

      subagents.assistantMessage('toolu_1', { message: { content: [{ type: 'text', text: 'Something else' }] } })

      expect(events).toEqual([
        { type: 'subagent_stream_start', parentToolId: 'toolu_1', agentId: 'a1' },
        { type: 'subagent_stream_delta', parentToolId: 'toolu_1', agentId: 'a1', text: 'Something else' },
      ])
    })

    it('sends only the rest of text that partly streamed', () => {
      const { subagents, events } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } })
      events.length = 0

      subagents.assistantMessage('toolu_1', { message: { content: [{ type: 'text', text: 'Hello world' }] } })

      expect(events).toEqual([{ type: 'subagent_stream_delta', parentToolId: 'toolu_1', agentId: 'a1', text: ' world' }])
    })

    it('sends nothing for text that fully streamed', () => {
      const { subagents, events } = startedForeground()
      subagents.streamEvent('toolu_1', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } })
      events.length = 0

      subagents.assistantMessage('toolu_1', { message: { content: [{ type: 'text', text: 'Hello' }] } })

      expect(events).toEqual([])
    })

    it('gives an input-less call an empty object', () => {
      const { subagents } = startedForeground()

      expect(subagents.assistantMessage('toolu_1', { message: { content: [{ type: 'tool_use', id: 'inner_1', name: 'Glob' }] } }))
        .toEqual([{ id: 'inner_1', name: 'Glob', input: '{}' }])
    })

    it('returns nothing for a subagent it is not tracking, or a malformed message', () => {
      const { subagents } = startedForeground()

      expect(subagents.assistantMessage('toolu_unknown', { message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash' }] } })).toEqual([])
      expect(subagents.assistantMessage('toolu_1', { message: { content: 'text' } })).toEqual([])
    })

    it('tells clients to refetch a persisted message', () => {
      const { subagents, events } = startedForeground()

      subagents.messageUpdated('toolu_1')
      subagents.messageUpdated('toolu_unknown')

      expect(events).toEqual([
        { type: 'subagent_updated', parentToolId: 'toolu_1', agentId: 'a1' },
        { type: 'subagent_updated', parentToolId: 'toolu_unknown', agentId: null },
      ])
    })
  })
})
