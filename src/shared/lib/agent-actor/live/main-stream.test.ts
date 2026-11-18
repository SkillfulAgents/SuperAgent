import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainStream } from './main-stream'
import type { SessionEvent } from './session-channel'
import { TOOL_INPUT_FRAME_MIN_INTERVAL_MS, TOOL_INPUT_WIRE_CHARS_PER_MS } from './tool-input-throttle'

/** A stream over a sink that records what it heard. */
function recordingStream() {
  const events: SessionEvent[] = []
  const streamed: string[] = []
  let responsesStarted = 0
  const stream = new MainStream({
    emit: (event) => events.push(event),
    responseStarted: () => {
      responsesStarted += 1
    },
    textStreamed: (text) => streamed.push(text),
  })
  return {
    stream,
    events,
    streamed,
    responsesStarted: () => responsesStarted,
    types: () => events.map((e) => e.type),
    clear: () => {
      events.length = 0
    },
  }
}

const messageStart = (id: string | undefined = 'msg_1') => ({ type: 'message_start', message: id ? { id } : {} })
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
  afterEach(() => {
    vi.useRealTimers()
  })

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
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))

      stream.event(inputDelta('{"command":'))
      stream.event(inputDelta('"ls"}'))
      // The first frame goes at once; the next waits its interval.
      expect(events.at(-1)).toEqual({ type: 'tool_use_streaming', toolId: 'tool_1', toolName: 'Bash', partialInput: '{"command":' })
      vi.advanceTimersByTime(TOOL_INPUT_FRAME_MIN_INTERVAL_MS)

      expect(events.slice(-2)).toEqual([
        { type: 'tool_use_streaming', toolId: 'tool_1', toolName: 'Bash', partialInput: '{"command":' },
        { type: 'tool_use_streaming', toolId: 'tool_1', toolName: 'Bash', partialInput: '{"command":"ls"}' },
      ])
    })

    it('masks a secret in a secret-bearing tool input on its way to clients', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'mcp__user-input__create_webhook_endpoint'))

      stream.event(inputDelta('{"name":"hook","secret":"s3cr'))
      stream.event(inputDelta('et"}'))
      vi.advanceTimersByTime(TOOL_INPUT_FRAME_MIN_INTERVAL_MS)

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

  describe('pacing a tool call\'s input', () => {
    const streamingFrames = (events: SessionEvent[]) => events.filter((e) => e.type === 'tool_use_streaming')
    const wireBytes = (events: SessionEvent[]) => events.reduce((sum, e) => sum + JSON.stringify(e).length, 0)

    /** A Write of ~50 KB as the provider streams it: 40-character deltas, `gapMs` apart. */
    function streamLargeWrite(gapMs: number) {
      const recorded = recordingStream()
      const { stream } = recorded
      const chunks: string[] = ['{"file_path":"/workspace/report.md","content":"']
      let length = chunks[0].length
      while (length < 50_000) {
        chunks.push('0123456789abcdefghijklmnopqrstuvwxyz ABC')
        length += 40
      }
      chunks.push('"}')
      const input = chunks.join('')
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Write'))
      let perDeltaBytes = 0
      let soFar = ''
      for (const chunk of chunks) {
        vi.advanceTimersByTime(gapMs)
        stream.event(inputDelta(chunk))
        soFar += chunk
        perDeltaBytes += JSON.stringify({ type: 'tool_use_streaming', toolId: 'tool_1', toolName: 'Write', partialInput: soFar }).length
      }
      const durationMs = gapMs * chunks.length
      const finished = stream.event(blockStop())
      stream.toolUseReady()
      return { ...recorded, input, deltas: chunks.length, perDeltaBytes, durationMs, finished }
    }

    it.each([
      ['in one burst', 0],
      ['at 125 deltas a second', 8],
      ['at 8 deltas a second', 125],
    ])('keeps the bytes of a 50 KB input linear, streamed %s', (_label, gapMs) => {
      vi.useFakeTimers()
      const { events, input, deltas, perDeltaBytes, durationMs, finished } = streamLargeWrite(gapMs)
      const frames = streamingFrames(events)
      const bytes = wireBytes(frames)

      // One frame per delta is what this replaces: ~31 MB for these ~1,250 deltas.
      expect(perDeltaBytes).toBeGreaterThan(30_000_000)
      // Never more often than the minimum interval, plus the first and the last.
      expect(frames.length).toBeLessThanOrEqual(Math.floor(durationMs / TOOL_INPUT_FRAME_MIN_INTERVAL_MS) + 2)
      expect(frames.length).toBeLessThanOrEqual(deltas)
      // Every frame but the last is followed by quiet in proportion to its
      // size, so the total is bounded by the time the input took to stream
      // (plus the last frame and each frame's envelope), not by its square.
      expect(bytes).toBeLessThanOrEqual(TOOL_INPUT_WIRE_CHARS_PER_MS * durationMs + 2 * input.length + 200 * frames.length)
      expect(bytes).toBeLessThan(perDeltaBytes / 2)

      // Each frame carries more of the same input than the one before it.
      for (let i = 0; i < frames.length; i += 1) {
        const partial = frames[i].partialInput as string
        expect(input.startsWith(partial)).toBe(true)
        if (i > 0) expect(partial.length).toBeGreaterThan((frames[i - 1].partialInput as string).length)
      }
      // The last one carries all of it, and comes before the ready frame.
      expect(frames.at(-1)?.partialInput).toBe(input)
      expect(finished).toEqual({ id: 'tool_1', name: 'Write', input })
      expect(events.at(-2)).toBe(frames.at(-1))
      expect(events.at(-1)).toEqual({ type: 'tool_use_ready', toolId: 'tool_1', toolName: 'Write' })
    })

    it('sends a burst as its first and its last frame', () => {
      vi.useFakeTimers()
      const { events, perDeltaBytes } = streamLargeWrite(0)

      const frames = streamingFrames(events)
      expect(frames).toHaveLength(2)
      expect(wireBytes(frames)).toBeLessThan(perDeltaBytes / 500)
    })

    it('sends nothing after the ready frame, however long it waits', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"command":'))
      stream.event(inputDelta('"ls"}'))
      stream.event(blockStop())
      stream.toolUseReady()
      const heard = events.length

      vi.advanceTimersByTime(60_000)

      expect(events).toHaveLength(heard)
      expect(events.at(-1)?.type).toBe('tool_use_ready')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('sends a held frame when the provider pauses mid-input', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Write'))
      stream.event(inputDelta('{"file_path":'))
      stream.event(inputDelta('"/workspace/a.md",'))
      stream.event(inputDelta('"content":"'))
      expect(streamingFrames(events)).toHaveLength(1)

      // No further delta: the timer, not the next delta, brings the UI up to date.
      vi.advanceTimersByTime(TOOL_INPUT_FRAME_MIN_INTERVAL_MS)

      expect(streamingFrames(events).map((e) => e.partialInput)).toEqual([
        '{"file_path":',
        '{"file_path":"/workspace/a.md","content":"',
      ])
    })

    it('masks the secret in every frame it sends, held ones included', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'mcp__user-input__create_webhook_endpoint'))
      for (const chunk of ['{"name":"hook",', '"secret":"', 'hunter2-', 'part-two', '-part-three', '"}']) {
        stream.event(inputDelta(chunk))
        vi.advanceTimersByTime(TOOL_INPUT_FRAME_MIN_INTERVAL_MS / 2)
      }
      stream.event(blockStop())
      stream.toolUseReady()

      const frames = streamingFrames(events)
      expect(frames.length).toBeGreaterThan(2)
      expect(JSON.stringify(events)).not.toMatch(/hunter2|part-two|part-three/)
      expect(frames.at(-1)?.partialInput).toBe('{"name":"hook","secret":"***"}')
    })

    it('drops a held frame when the turn stops', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"command":'))
      stream.event(inputDelta('"ls"}'))

      stream.stop()
      vi.advanceTimersByTime(60_000)

      expect(streamingFrames(events)).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('holds nothing over into the next tool call', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"command":"ls"}'))
      stream.event(blockStop())
      stream.toolUseReady()

      // Straight after the first: its own first frame still goes at once.
      stream.event(toolStart('tool_2', 'Read', 1))
      stream.event(inputDelta('{"file_path":', 1))

      expect(events.at(-1)).toEqual({ type: 'tool_use_streaming', toolId: 'tool_2', toolName: 'Read', partialInput: '{"file_path":' })
    })

    it('does not send a held frame once the sink no longer takes late ones', () => {
      vi.useFakeTimers()
      const events: SessionEvent[] = []
      let live = true
      const stream = new MainStream({
        emit: (event) => events.push(event),
        responseStarted: () => {},
        textStreamed: () => {},
        mayStreamLate: () => live,
      })
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"command":'))
      stream.event(inputDelta('"ls"}'))

      live = false
      vi.advanceTimersByTime(60_000)

      expect(streamingFrames(events)).toHaveLength(1)
    })

    it('drops a held frame on request', () => {
      vi.useFakeTimers()
      const { stream, events } = recordingStream()
      stream.event(messageStart())
      stream.event(toolStart('tool_1', 'Bash'))
      stream.event(inputDelta('{"command":'))
      stream.event(inputDelta('"ls"}'))

      stream.dropHeldToolInput()
      vi.advanceTimersByTime(60_000)

      expect(streamingFrames(events)).toHaveLength(1)
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

    it('reads thinking from a delta whose block start was missed, and ends that block at its stop', () => {
      const { stream, events } = recordingStream()
      stream.event(messageStart('msg_1'))

      stream.event(thinkingDelta('still thinking', 2))
      expect(stream.isThinking).toBe(true)

      stream.event(blockStop(2))
      expect(stream.isThinking).toBe(false)
      expect(events.at(-1)).toEqual({ type: 'thinking_stop', thinkingId: 'msg_1:2' })
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
      expect(types()).toEqual(['compact_start', 'compact_complete', 'messages_updated'])
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
