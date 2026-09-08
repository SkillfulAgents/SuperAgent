// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

interface ListenerEvents {
  onUtterance: (text: string) => void
  onSpeechStarted?: () => void
  onSpeechEnded: () => void
  onError: (error: Error) => void
}

interface FakeListener {
  events: ListenerEvents
  utterance: string
  wordCount: number
  analyser: null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  take: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
  hear: (text: string) => void
}

const h = vi.hoisted(() => ({ listeners: [] as FakeListener[] }))

vi.mock('@renderer/lib/voice-listener', () => ({
  VoiceListener: class {
    utterance = ''
    analyser = null
    start = vi.fn(async () => {})
    stop = vi.fn()
    take = vi.fn(async () => {
      const text = this.utterance.trim()
      this.utterance = ''
      this.events.onUtterance('')
      return text
    })
    discard = vi.fn(async () => {
      this.utterance = ''
    })
    constructor(public events: ListenerEvents) {
      h.listeners.push(this as unknown as FakeListener)
    }
    get wordCount() {
      const text = this.utterance.trim()
      return text ? text.split(/\s+/).length : 0
    }
    hear(text: string) {
      this.utterance = text
      this.events.onUtterance(text)
    }
  },
}))

const reader = vi.hoisted(() => {
  let snapshot: { activeId: string | null; status: string; error: string | null; errorId: string | null } =
    { activeId: null, status: 'idle', error: null, errorId: null }
  const subscribers = new Set<() => void>()
  const api = {
    subscribe: (listener: () => void) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    getSnapshot: () => snapshot,
    set(next: Partial<typeof snapshot>) {
      snapshot = { ...snapshot, ...next }
      for (const listener of subscribers) listener()
    },
    reset() {
      snapshot = { activeId: null, status: 'idle', error: null, errorId: null }
    },
    beginStream: vi.fn((id: string) => api.set({ activeId: id, status: 'connecting' })),
    pushStream: vi.fn(),
    nextStreamSegment: vi.fn(),
    endStream: vi.fn(),
    duckStream: vi.fn(),
    stop: vi.fn(() => api.set({ activeId: null, status: 'idle' })),
    unlockAudio: vi.fn(),
  }
  return api
})
vi.mock('./use-read-aloud', () => ({ readAloud: reader, voiceStreamId: (sessionId: string) => `voice:${sessionId}` }))

const stream = vi.hoisted(() => ({
  state: { isActive: false, streamingMessage: null as string | null, streamingToolUses: [] as Array<{ id: string; name: string; partialInput: string }> },
}))
vi.mock('./use-message-stream', () => ({ useMessageStream: () => stream.state }))

// The server acknowledges an interrupt at once unless a test holds it.
const interruptSession = vi.hoisted(() => ({
  mutate: vi.fn((_vars: unknown, opts?: { onSettled?: () => void }) => opts?.onSettled?.()),
}))
vi.mock('./use-messages', () => ({ useInterruptSession: () => interruptSession }))

import { useVoiceMode, INTERRUPT_WORD_THRESHOLD, LISTENER_RESTART_MS, DUCK_MAX_MS } from './use-voice-mode'

const STREAM_ID = 'voice:s1'

function setup(options: { startWithAgentTurn?: boolean } = {}) {
  const send = vi.fn(async (_text: string) => true)
  const hook = renderHook(
    ({ active }: { active: boolean }) => useVoiceMode({ sessionId: 's1', agentSlug: 'agent', active, send, ...options }),
    { initialProps: { active: true } },
  )
  const listener = h.listeners[h.listeners.length - 1]
  const setStream = (next: Partial<typeof stream.state>) =>
    act(() => {
      stream.state = { ...stream.state, ...next }
      hook.rerender({ active: true })
    })
  return { ...hook, send, listener, setStream }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useVoiceMode', () => {
  beforeEach(() => {
    h.listeners.length = 0
    reader.reset()
    reader.beginStream.mockClear()
    reader.pushStream.mockClear()
    reader.nextStreamSegment.mockClear()
    reader.endStream.mockClear()
    reader.duckStream.mockClear()
    reader.stop.mockClear()
    interruptSession.mutate.mockClear()
    stream.state = { isActive: false, streamingMessage: null, streamingToolUses: [] }
  })

  it('opens the mic, shows what is heard, and sends it when the person pauses', async () => {
    const { result, listener, send } = setup()
    expect(listener.start).toHaveBeenCalledTimes(1)
    expect(result.current.phase).toBe('listening')

    act(() => listener.hear('hello there'))
    expect(result.current.utterance).toBe('hello there')

    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(listener.take).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('hello there')
    expect(result.current.phase).toBe('thinking')
    expect(result.current.utterance).toBe('')
  })

  it('silence with nothing heard sends nothing', async () => {
    const { listener, send, result } = setup()
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('listening')
  })

  it('reads the reply as it streams, segment by segment, and hands the floor back once spoken', async () => {
    const { result, listener, setStream } = setup()
    act(() => listener.hear('go'))
    act(() => listener.events.onSpeechEnded())
    await flush()

    setStream({ isActive: true, streamingMessage: 'Hello there. How' })
    expect(reader.beginStream).toHaveBeenCalledWith(STREAM_ID)
    expect(reader.pushStream).toHaveBeenLastCalledWith(STREAM_ID, 'Hello there. How')

    setStream({ streamingMessage: 'Hello there. How are you?' })
    expect(reader.pushStream).toHaveBeenLastCalledWith(STREAM_ID, 'Hello there. How are you?')
    expect(reader.nextStreamSegment).not.toHaveBeenCalled()

    // A tool call in between: the next assistant message starts empty.
    setStream({ streamingMessage: '' })
    expect(reader.nextStreamSegment).toHaveBeenCalledTimes(1)
    setStream({ streamingMessage: 'Second part.' })
    expect(reader.pushStream).toHaveBeenLastCalledWith(STREAM_ID, 'Second part.')

    act(() => reader.set({ status: 'speaking' }))
    expect(result.current.phase).toBe('speaking')

    setStream({ isActive: false })
    expect(reader.endStream).toHaveBeenCalledWith(STREAM_ID)
    // Still playing out the last words.
    expect(result.current.phase).toBe('speaking')

    act(() => reader.set({ activeId: null, status: 'idle' }))
    expect(result.current.phase).toBe('listening')
    expect(listener.discard).not.toHaveBeenCalled()
  })

  it('drops words heard well before the agent finished, keeps words heard as it did', async () => {
    vi.useFakeTimers()
    try {
      const { result, listener, setStream } = setup()
      act(() => listener.hear('go'))
      act(() => listener.events.onSpeechEnded())
      await flush()
      setStream({ isActive: true, streamingMessage: 'A long reply. ' })
      // Noise early in the reply...
      act(() => listener.hear('mm hmm'))
      vi.advanceTimersByTime(10_000)
      setStream({ isActive: false })
      act(() => reader.set({ activeId: null, status: 'idle' }))
      expect(result.current.phase).toBe('listening')
      expect(listener.discard).toHaveBeenCalledTimes(1)

      // ...versus the person starting to answer as the reply ends.
      act(() => listener.hear('okay so'))
      act(() => listener.events.onSpeechEnded())
      await flush()
      setStream({ isActive: true, streamingMessage: 'Another reply. ' })
      act(() => listener.hear('yes but'))
      vi.advanceTimersByTime(500)
      setStream({ isActive: false })
      act(() => reader.set({ activeId: null, status: 'idle' }))
      expect(result.current.phase).toBe('listening')
      expect(listener.discard).toHaveBeenCalledTimes(1)
      expect(result.current.utterance).toBe('yes but')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ducks the reply as soon as the person starts talking over it, and restores it if they stop short', async () => {
    const { listener, setStream } = setup()
    act(() => listener.hear('go'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    setStream({ isActive: true, streamingMessage: 'Long reply. ' })
    act(() => listener.events.onSpeechStarted?.())
    expect(reader.duckStream).toHaveBeenLastCalledWith(STREAM_ID, true)
    act(() => listener.hear('um'))
    act(() => listener.events.onSpeechEnded())
    expect(reader.duckStream).toHaveBeenLastCalledWith(STREAM_ID, false)
  })

  it('voice activity with no words behind it stops ducking the reply after a moment', async () => {
    vi.useFakeTimers()
    try {
      const { listener, setStream } = setup()
      act(() => listener.hear('go'))
      act(() => listener.events.onSpeechEnded())
      await flush()
      setStream({ isActive: true, streamingMessage: 'Long reply. ' })
      act(() => listener.events.onSpeechStarted?.())
      expect(reader.duckStream).toHaveBeenLastCalledWith(STREAM_ID, true)
      // A cough: no words, so no silence signal either.
      act(() => vi.advanceTimersByTime(DUCK_MAX_MS - 100))
      expect(reader.duckStream).toHaveBeenLastCalledWith(STREAM_ID, true)
      act(() => vi.advanceTimersByTime(200))
      expect(reader.duckStream).toHaveBeenLastCalledWith(STREAM_ID, false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts words per breath: scattered noise over a long turn never adds up to an interruption', async () => {
    const { result, listener, setStream } = setup()
    act(() => listener.hear('go'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    setStream({ isActive: true, streamingMessage: 'Long reply. ' })
    act(() => listener.events.onSpeechStarted?.())
    act(() => listener.hear('mm hmm'))
    act(() => listener.events.onSpeechEnded())
    act(() => listener.events.onSpeechStarted?.())
    act(() => listener.hear('mm hmm ok'))
    act(() => listener.events.onSpeechEnded())
    act(() => listener.events.onSpeechStarted?.())
    act(() => listener.hear('mm hmm ok right'))
    expect(listener.wordCount).toBe(INTERRUPT_WORD_THRESHOLD)
    expect(interruptSession.mutate).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('thinking')

    // Four words in one breath do interrupt.
    act(() => listener.events.onSpeechEnded())
    act(() => listener.events.onSpeechStarted?.())
    act(() => listener.hear('mm hmm ok right stop right there please'))
    expect(interruptSession.mutate).toHaveBeenCalledTimes(1)
    expect(result.current.phase).toBe('listening')
  })

  it('a reply with no text to read hands the floor back at the end of the turn', async () => {
    const { result, listener, setStream } = setup()
    act(() => listener.hear('do a thing'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    setStream({ isActive: true })
    setStream({ isActive: false })
    expect(reader.beginStream).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('listening')
  })

  it('never re-reads the previous reply after the next send', async () => {
    const { listener, setStream } = setup()
    stream.state = { streamingToolUses: [], isActive: false, streamingMessage: 'Old reply, still on screen.' }
    act(() => listener.hear('next question'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(reader.beginStream).not.toHaveBeenCalled()

    setStream({ isActive: true })
    expect(reader.pushStream).not.toHaveBeenCalled()

    setStream({ streamingMessage: 'New reply.' })
    expect(reader.beginStream).toHaveBeenCalledWith(STREAM_ID)
    expect(reader.pushStream).toHaveBeenLastCalledWith(STREAM_ID, 'New reply.')
  })

  it('talking over the agent past a few words interrupts it and keeps the words', async () => {
    const { result, listener, setStream } = setup()
    act(() => listener.hear('go'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    setStream({ isActive: true, streamingMessage: 'Long reply. ' })
    act(() => reader.set({ status: 'speaking' }))

    const below = Array.from({ length: INTERRUPT_WORD_THRESHOLD - 1 }, (_, i) => `w${i}`).join(' ')
    act(() => listener.hear(below))
    expect(result.current.phase).toBe('speaking')
    expect(interruptSession.mutate).not.toHaveBeenCalled()

    const enough = `${below} more`
    act(() => listener.hear(enough))
    expect(reader.stop).toHaveBeenCalled()
    expect(interruptSession.mutate).toHaveBeenCalledWith({ sessionId: 's1', agentSlug: 'agent' }, expect.anything())
    expect(result.current.phase).toBe('listening')
    expect(result.current.utterance).toBe(enough)
  })

  it('the mic button sends while listening and interrupts while the agent has the floor', async () => {
    const { result, listener, send, setStream } = setup()
    act(() => listener.hear('send this'))
    act(() => result.current.pressMic())
    await flush()
    expect(send).toHaveBeenCalledWith('send this')
    expect(result.current.phase).toBe('thinking')

    setStream({ isActive: true })
    act(() => result.current.pressMic())
    expect(interruptSession.mutate).toHaveBeenCalledTimes(1)
    expect(reader.stop).toHaveBeenCalled()
    expect(result.current.phase).toBe('listening')
  })

  it('interrupts a message just sent, before the stream reports the turn', async () => {
    const { result, listener } = setup()
    act(() => listener.hear('do it'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(result.current.phase).toBe('thinking')
    // isActive is still false: the server has not confirmed the turn yet.
    act(() => result.current.pressMic())
    expect(interruptSession.mutate).toHaveBeenCalledWith({ sessionId: 's1', agentSlug: 'agent' }, expect.anything())
    expect(result.current.phase).toBe('listening')
  })

  it('a send right after an interrupt does not take the interrupted turn for its own', async () => {
    const { result, listener, send, setStream } = setup()
    act(() => listener.hear('go'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    setStream({ isActive: true, streamingMessage: 'Long reply. ' })
    act(() => reader.set({ status: 'speaking' }))

    const enough = Array.from({ length: INTERRUPT_WORD_THRESHOLD }, (_, i) => `w${i}`).join(' ')
    act(() => listener.hear(enough))
    expect(result.current.phase).toBe('listening')
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(send).toHaveBeenLastCalledWith(enough)
    // The stream still shows the interrupted turn as active: not this send's turn.
    expect(result.current.phase).toBe('thinking')
    reader.beginStream.mockClear()
    reader.pushStream.mockClear()

    // The interrupted turn ends. The floor stays with the agent: the reply
    // to what was just sent is on its way.
    setStream({ isActive: false, streamingMessage: null })
    expect(result.current.phase).toBe('thinking')
    setStream({ isActive: true, streamingMessage: 'New reply. ' })
    expect(reader.beginStream).toHaveBeenCalledWith(STREAM_ID)
    expect(reader.pushStream).toHaveBeenLastCalledWith(STREAM_ID, 'New reply. ')
    act(() => reader.set({ status: 'speaking' }))
    expect(result.current.phase).toBe('speaking')
  })

  it('the send after an interrupt waits for the server to acknowledge the interrupt', async () => {
    let acknowledge: () => void = () => {}
    interruptSession.mutate.mockImplementationOnce((_vars: unknown, opts?: { onSettled?: () => void }) => {
      acknowledge = () => opts?.onSettled?.()
    })
    const { result, listener, send, setStream } = setup()
    act(() => listener.hear('go'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    setStream({ isActive: true, streamingMessage: 'Long reply. ' })
    act(() => result.current.pressMic())
    expect(interruptSession.mutate).toHaveBeenCalledTimes(1)
    act(() => listener.hear('actually this'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(result.current.phase).toBe('thinking')
    expect(send).toHaveBeenCalledTimes(1)
    act(() => acknowledge())
    await flush()
    expect(send).toHaveBeenLastCalledWith('actually this')
  })

  it('reopens a mic that died, showing the error until it is back', async () => {
    vi.useFakeTimers()
    try {
      const { result, listener } = setup()
      act(() => listener.events.onError(new Error('connection lost')))
      expect(result.current.error).toBe('connection lost')
      expect(h.listeners).toHaveLength(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LISTENER_RESTART_MS)
      })
      expect(h.listeners).toHaveLength(2)
      expect(listener.stop).toHaveBeenCalled()
      expect(h.listeners[1].start).toHaveBeenCalledTimes(1)
      await flush()
      expect(result.current.error).toBeNull()
      expect(result.current.phase).toBe('listening')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a send that fails hands the floor back and reports it', async () => {
    const { result, listener, send } = setup()
    send.mockRejectedValueOnce(new Error('offline'))
    act(() => listener.hear('hello'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(result.current.phase).toBe('listening')
    expect(result.current.error).toBe('offline')

    send.mockResolvedValueOnce(false)
    act(() => listener.hear('hello again'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    expect(result.current.phase).toBe('listening')
    expect(result.current.error).toMatch(/say it again/)
  })

  it('reports the agent as working once its turn reaches a tool call, until the floor comes back', async () => {
    const { result, listener, setStream } = setup()
    expect(result.current.working).toBe(false)
    act(() => listener.hear('look it up'))
    act(() => listener.events.onSpeechEnded())
    await flush()
    // Thinking, then an opening sentence: not working yet.
    setStream({ isActive: true, streamingMessage: "I'll look that up. " })
    expect(result.current.working).toBe(false)
    setStream({ streamingToolUses: [{ id: 't1', name: 'WebSearch', partialInput: '' }] })
    expect(result.current.working).toBe(true)
    // Sticky through the rest of the turn, tool finished or not.
    setStream({ streamingToolUses: [], streamingMessage: 'Here is what I found. ' })
    expect(result.current.working).toBe(true)
    setStream({ isActive: false, streamingMessage: null })
    act(() => reader.set({ activeId: null, status: 'idle' }))
    expect(result.current.phase).toBe('listening')
    expect(result.current.working).toBe(false)
  })

  it('a session opened by voice starts with the agent replying to the notice', () => {
    const { result, setStream } = setup({ startWithAgentTurn: true })
    expect(result.current.phase).toBe('thinking')
    setStream({ isActive: true, streamingMessage: 'Hi, I am listening. ' })
    expect(reader.beginStream).toHaveBeenCalledWith(STREAM_ID)
    expect(reader.pushStream).toHaveBeenLastCalledWith(STREAM_ID, 'Hi, I am listening. ')
  })

  it('turning voice mode off releases the mic and silences the reader', () => {
    const { rerender, listener } = setup()
    rerender({ active: false })
    expect(listener.stop).toHaveBeenCalledTimes(1)
    expect(reader.stop).toHaveBeenCalled()
  })
})
