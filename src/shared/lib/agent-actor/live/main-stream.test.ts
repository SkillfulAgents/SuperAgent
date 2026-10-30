import { describe, expect, it } from 'vitest'
import { MainStream } from './main-stream'
import type { SessionEvent } from './session-channel'

/**
 * A stream over a sink that records what it heard. `windows` stands for the
 * session's knowledge of model windows: a test can teach it one later.
 */
function recordingStream(windows: Record<string, number> = {}) {
  const events: SessionEvent[] = []
  const streamed: string[] = []
  let responsesStarted = 0
  const stream = new MainStream({
    emit: (event) => events.push(event),
    responseStarted: () => {
      responsesStarted += 1
    },
    textStreamed: (text) => streamed.push(text),
  }, (model) => (model ? windows[model] : undefined))
  return {
    stream,
    events,
    streamed,
    windows,
    responsesStarted: () => responsesStarted,
    types: () => events.map((e) => e.type),
    clear: () => {
      events.length = 0
    },
  }
}

const messageStart = (id: string | undefined = 'msg_1', model?: string) => ({
  type: 'message_start',
  message: { ...(id ? { id } : {}), ...(model ? { model } : {}) },
})
const textDelta = (text: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const toolStart = (id: string, name: string, index = 0) => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', id, name },
})
const inputDelta = (json: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } })
const thinkingStart = (index?: number) => ({ type: 'content_block_start', index, content_block: { type: 'thinking' } })
const thinkingDelta = (thinking: string, index?: number) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
const blockStop = (index = 0) => ({ type: 'content_block_stop', index })
const messageStop = () => ({ type: 'message_stop' })

describe('MainStream', () => {
  describe('a message starting', () => {
    it('announces the stream and starts the reply context over', () => {
      const { stream, events, responsesStarted } = recordingStream()

      expect(stream.event(messageStart())).toBeNull()

      expect(events).toEqual([{ type: 'stream_start' }])
      expect(responsesStarted()).toBe(1)
    })

    it('resets what the previous message left behind', () => {
      const { stream } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(textDelta('old'))
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(thinkingStart(1))

      stream.event(messageStart('msg_2'))

      expect(stream.currentText).toBe('')
      expect(stream.isStreaming).toBe(false)
      expect(stream.currentToolUse).toBeNull()
      expect(stream.isThinking).toBe(false)
    })

    it('resolves a retry: the response is flowing again', () => {
      const { stream } = recordingStream()
      stream.retrying({ attempt: 1 })
      expect(stream.isRetrying).toBe(true)

      stream.event(messageStart())

      expect(stream.isRetrying).toBe(false)
    })
  })

  describe('reply text', () => {
    it('streams each text delta to clients and to the reply context', () => {
      const { stream, events, streamed } = recordingStream()
      stream.event(messageStart())

      stream.event(textDelta('Hel'))
      stream.event(textDelta('lo'))

      expect(stream.currentText).toBe('Hello')
      expect(streamed).toEqual(['Hel', 'lo'])
      expect(events.slice(1)).toEqual([
        { type: 'stream_delta', text: 'Hel' },
        { type: 'stream_delta', text: 'lo' },
      ])
    })

    it('starts streaming at the first text token, not at message start', () => {
      const { stream } = recordingStream()
      stream.event(messageStart())
      expect(stream.isStreaming).toBe(false)

      stream.event(textDelta('Hi'))

      expect(stream.isStreaming).toBe(true)
    })

    it('ignores an empty text delta', () => {
      const { stream, events, streamed } = recordingStream()
      stream.event(messageStart())

      stream.event(textDelta(''))

      expect(stream.isStreaming).toBe(false)
      expect(streamed).toEqual([])
      expect(events).toEqual([{ type: 'stream_start' }])
    })

    it('keeps the text past message_stop, until the complete message is persisted', () => {
      const { stream } = recordingStream()
      stream.event(messageStart())
      stream.event(textDelta('Done.'))

      stream.event(messageStop())
      expect(stream.isStreaming).toBe(false)
      expect(stream.currentText).toBe('Done.')

      stream.messagePersisted()
      expect(stream.currentText).toBe('')
    })
  })

  describe('tool calls', () => {
    it('keeps a message that opens with a tool call working, never streaming', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart())

      stream.event(toolStart('tool_1', 'Bash'))

      expect(stream.isStreaming).toBe(false)
      expect(stream.currentToolUse).toEqual({ id: 'tool_1', name: 'Bash' })
      expect(events.at(-1)).toEqual({ type: 'tool_use_start', toolId: 'tool_1', toolName: 'Bash', partialInput: '' })
    })

    it('streams the input as it accumulates', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))

      stream.event(inputDelta('{"command":'))
      stream.event(inputDelta('"ls"}'))

      expect(events.slice(-2)).toEqual([
        { type: 'tool_use_streaming', toolId: 'tool_1', toolName: 'Bash', partialInput: '{"command":' },
        { type: 'tool_use_streaming', toolId: 'tool_1', toolName: 'Bash', partialInput: '{"command":"ls"}' },
      ])
    })

    it('masks a secret in a secret-bearing tool input on its way to clients', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'mcp__user-input__create_webhook_endpoint'))

      stream.event(inputDelta('{"name":"hook","secret":"s3cr'))
      stream.event(inputDelta('et"}'))

      expect(events.slice(-2).map((e) => e.partialInput)).toEqual([
        '{"name":"hook","secret":"***',
        '{"name":"hook","secret":"***"}',
      ])
    })

    it('returns the finished call, with its raw input, at its block stop', () => {
      const { stream } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'mcp__user-input__create_webhook_endpoint'))
      stream.event(inputDelta('{"secret":"abc"}'))

      expect(stream.event(blockStop())).toEqual({
        id: 'tool_1',
        name: 'mcp__user-input__create_webhook_endpoint',
        input: '{"secret":"abc"}',
      })
    })

    it('returns nothing at the stop of a block that is not a tool call', () => {
      const { stream } = recordingStream()
      stream.event(messageStart())
      stream.event(textDelta('Hi'))

      expect(stream.event(blockStop())).toBeNull()
    })

    it('stops the card streaming once the finished call has been acted on', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{}'))
      stream.event(blockStop())

      stream.toolUseReady()

      expect(events.at(-1)).toEqual({ type: 'tool_use_ready', toolId: 'tool_1', toolName: 'Bash' })
      expect(stream.currentToolUse).toBeNull()
      expect(stream.currentToolInput).toBe('')
    })

    it('says nothing when there is no call to mark ready', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart())

      stream.toolUseReady()

      expect(events).toEqual([{ type: 'stream_start' }])
    })

    it('starts a second call with an empty input', () => {
      const { stream } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash', 0))
      stream.event(inputDelta('{"a":1}', 0))
      stream.event(blockStop(0))
      stream.toolUseReady()
      stream.event(toolStart('tool_2', 'Read', 1))
      stream.event(inputDelta('{"b":2}', 1))

      expect(stream.event(blockStop(1))).toEqual({ id: 'tool_2', name: 'Read', input: '{"b":2}' })
    })

    it('drops the call being written when the message stops', () => {
      const { stream } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"comm'))

      stream.event(messageStop())

      expect(stream.currentToolUse).toBeNull()
      expect(stream.currentToolInput).toBe('')
    })
  })

  describe('thinking', () => {
    it('names a thinking block by its message id and content index, matching the persisted block', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))

      stream.event(thinkingStart(0))
      stream.event(thinkingDelta('Let me see', 0))
      stream.event(blockStop(0))

      expect(events.slice(1)).toEqual([
        { type: 'thinking_start', thinkingId: 'msg_1:0' },
        { type: 'thinking_delta', thinkingId: 'msg_1:0', text: 'Let me see' },
        { type: 'thinking_stop', thinkingId: 'msg_1:0' },
      ])
    })

    it('reads thinking from the block start until its stop', () => {
      const { stream } = recordingStream()
      stream.event(messageStart('msg_1'))

      stream.event(thinkingStart(0))
      expect(stream.isThinking).toBe(true)

      expect(stream.event(blockStop(0))).toBeNull()
      expect(stream.isThinking).toBe(false)
    })

    it('ignores an empty thinking delta', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(thinkingStart(0))

      stream.event(thinkingDelta('', 0))

      expect(events.map((e) => e.type)).toEqual(['stream_start', 'thinking_start'])
    })

    it('takes the block index from the delta after a reconnect that missed content_block_start', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))

      stream.event(thinkingDelta('still thinking', 2))

      expect(events.at(-1)).toEqual({ type: 'thinking_delta', thinkingId: 'msg_1:2', text: 'still thinking' })
    })

    it('has no id for a block whose message start was missed', () => {
      const { stream, events } = recordingStream()

      stream.event(thinkingStart(0))
      stream.event(thinkingDelta('hmm', 0))

      expect(events).toEqual([
        { type: 'thinking_start', thinkingId: undefined },
        { type: 'thinking_delta', thinkingId: undefined, text: 'hmm' },
      ])
    })

    it('ends a thinking block whose stop was missed with its message, under its own id', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(thinkingStart(1))

      stream.event(messageStop())

      expect(stream.isThinking).toBe(false)
      expect(events.at(-1)).toEqual({ type: 'thinking_stop', thinkingId: 'msg_1:1' })
    })

    it('gives two thinking blocks in one message their own ids', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(thinkingStart(0))
      stream.event(blockStop(0))
      stream.event(thinkingStart(2))
      stream.event(blockStop(2))

      expect(events.filter((e) => e.type === 'thinking_stop')).toEqual([
        { type: 'thinking_stop', thinkingId: 'msg_1:0' },
        { type: 'thinking_stop', thinkingId: 'msg_1:2' },
      ])
    })
  })

  describe('usage', () => {
    it('reports one call\'s usage against the window of the model it ran on, defaulting missing counts to zero', () => {
      const { stream, events } = recordingStream({ 'claude-opus-5-5': 1_000_000 })

      stream.reportUsage({ input_tokens: 100, cache_read_input_tokens: 900 }, 'claude-opus-5-5')

      const expected = {
        inputTokens: 100,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 900,
        contextWindow: 1_000_000,
        model: 'claude-opus-5-5',
      }
      expect(stream.lastUsage).toEqual(expected)
      expect(events).toEqual([{ type: 'context_usage', ...expected }])
    })

    it('sends a window the session does not know yet as 0, not as a guess', () => {
      const { stream } = recordingStream()

      stream.reportUsage({ input_tokens: 2, cache_read_input_tokens: 89_344 }, 'claude-opus-5-5')

      expect(stream.lastUsage).toMatchObject({ contextWindow: 0, model: 'claude-opus-5-5' })
    })

    it('reads message_delta usage against the model its message_start named', () => {
      const { stream, events } = recordingStream({ 'gpt-6.1-sol': 272_000 })
      stream.event(messageStart('msg_1', 'gpt-6.1-sol'))
      events.length = 0

      stream.event({ type: 'message_delta', usage: { input_tokens: 51_300, cache_read_input_tokens: 39_424, output_tokens: 5 } })

      expect(stream.lastUsage).toMatchObject({ inputTokens: 51_300, cacheReadInputTokens: 39_424, contextWindow: 272_000, model: 'gpt-6.1-sol' })
      expect(events.map((e) => e.type)).toEqual(['context_usage'])
    })

    it('reads each call against its own model after a model switch', () => {
      const { stream } = recordingStream({ 'claude-opus-5-5': 1_000_000, 'gpt-6.1-sol': 272_000 })
      stream.reportUsage({ input_tokens: 246_207 }, 'claude-opus-5-5')

      stream.event(messageStart('msg_2', 'gpt-6.1-sol'))
      stream.event({ type: 'message_delta', usage: { input_tokens: 14_573, output_tokens: 1 } })

      expect(stream.lastUsage).toMatchObject({ contextWindow: 272_000, model: 'gpt-6.1-sol' })
    })

    it('takes the final usage from message_delta', () => {
      const { stream, events } = recordingStream()

      stream.event({ type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5 } })

      expect(stream.lastUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
      expect(events.map((e) => e.type)).toEqual(['context_usage'])
    })

    it('ignores a message_delta whose usage carries no token counts', () => {
      const { stream, events } = recordingStream()

      stream.event({ type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 50 } })
      stream.event({ type: 'message_delta' })

      expect(stream.lastUsage).toBeNull()
      expect(events).toEqual([])
    })

    it('settles the latest call\'s usage against the window the session learned from the result, and returns it', () => {
      const { stream, events, windows } = recordingStream()
      stream.reportUsage({ input_tokens: 100, output_tokens: 20 }, 'claude-opus-5-5')
      events.length = 0
      windows['claude-opus-5-5'] = 1_000_000

      const settled = stream.settleUsage()

      const expected = {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 1_000_000,
        model: 'claude-opus-5-5',
      }
      expect(settled).toEqual(expected)
      expect(stream.lastUsage).toEqual(expected)
      expect(events).toEqual([{ type: 'context_usage', ...expected }])
    })

    it('returns nothing to settle before any usage', () => {
      const { stream, events } = recordingStream({ 'claude-opus-5-5': 1_000_000 })

      expect(stream.settleUsage()).toBeNull()
      expect(events).toEqual([])
    })
  })

  describe('compaction', () => {
    it('announces a compaction once, however many signals report it', () => {
      const { stream, types } = recordingStream()

      stream.compactionStarted()
      stream.compactionStarted()

      expect(stream.isCompacting).toBe(true)
      expect(types()).toEqual(['compact_start'])
    })

    it('ends with the boundary: clients swap the spinner and refetch', () => {
      const { stream, types } = recordingStream()
      stream.compactionStarted()

      stream.compactionEnded()

      expect(stream.isCompacting).toBe(false)
      expect(types()).toEqual(['compact_start', 'context_usage', 'compact_complete', 'messages_updated'])
    })

    it('leaves the context unmeasured once the summary replaced it', () => {
      const { stream, events } = recordingStream({ 'claude-opus-5-5': 1_000_000 })
      stream.reportUsage({ input_tokens: 2, cache_creation_input_tokens: 821, cache_read_input_tokens: 957_637 }, 'claude-opus-5-5')
      stream.compactionStarted()
      events.length = 0

      stream.compactionEnded()

      expect(stream.lastUsage).toBeNull()
      expect(events[0]).toEqual({
        type: 'context_usage',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 0,
      })
      // The compact turn's result has nothing old to send again.
      expect(stream.settleUsage()).toBeNull()
    })
  })

  describe('retries', () => {
    it('reports a retry with the SDK\'s numbers', () => {
      const { stream, events } = recordingStream()

      stream.retrying({ attempt: 2, max_retries: 10, delay_ms: 4000, error_status: 529 })

      expect(stream.isRetrying).toBe(true)
      expect(events).toEqual([{ type: 'api_retry', attempt: 2, maxRetries: 10, delayMs: 4000, errorStatus: 529 }])
    })
  })

  describe('turn boundaries', () => {
    it('does not carry a compacting, thinking or retrying label into a new turn', () => {
      const { stream } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(thinkingStart(0))
      stream.compactionStarted()
      stream.retrying({ attempt: 1 })

      stream.newTurn()

      expect(stream.isCompacting).toBe(false)
      expect(stream.isThinking).toBe(false)
      expect(stream.isRetrying).toBe(false)
    })

    it('forgets the old message\'s thinking id at a new turn', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(thinkingStart(0))

      stream.newTurn()
      stream.event(thinkingDelta('fresh'))

      expect(events.at(-1)).toEqual({ type: 'thinking_delta', thinkingId: undefined, text: 'fresh' })
    })

    it('a new turn announces nothing', () => {
      const { stream, events, clear } = recordingStream()
      stream.event(messageStart('msg_1'))
      stream.event(thinkingStart(0))
      clear()

      stream.newTurn()

      expect(events).toEqual([])
    })

    it('stops everything streaming when the turn stops', () => {
      const { stream, events, clear } = recordingStream()
      stream.event(messageStart())
      stream.event(textDelta('partial'))
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"x"'))
      clear()

      stream.stop()

      expect(stream.isStreaming).toBe(false)
      expect(stream.currentText).toBe('')
      expect(stream.currentToolUse).toBeNull()
      expect(stream.currentToolInput).toBe('')
      expect(events).toEqual([])
      stream.toolUseReady()
      expect(events).toEqual([])
    })
  })

  it('ignores events it does not know', () => {
    const { stream, events } = recordingStream()

    expect(stream.event({ type: 'ping' })).toBeNull()
    expect(stream.event({ type: 'content_block_start', content_block: { type: 'text' } })).toBeNull()
    expect(stream.event({ type: 'content_block_delta', delta: { type: 'signature_delta' } })).toBeNull()

    expect(events).toEqual([])
  })
})
