// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'

const apiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const createTtsAdapter = vi.fn((_provider: string) => ({ fake: 'adapter' }))
vi.mock('@renderer/lib/tts', () => ({ createTtsAdapter: (provider: string) => createTtsAdapter(provider) }))

interface FakePlayer {
  options: { adapter: unknown; token: string; voice: { voice: string; speed?: number }; firstWordIndex?: number; onStatus?: (s: string, e?: Error) => void }
  status: string
  start: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  getWordCursor: ReturnType<typeof vi.fn>
  totalWords: number
}
const players: FakePlayer[] = []
vi.mock('@renderer/lib/speech/speech-player', () => ({
  SpeechPlayer: class {
    status = 'speaking'
    acceptsWords = true
    start = vi.fn()
    append = vi.fn()
    end = vi.fn()
    stop = vi.fn()
    pause = vi.fn()
    resume = vi.fn()
    setVolume = vi.fn()
    getWordCursor = vi.fn(() => -1)
    get totalWords() {
      return this.append.mock.calls.reduce((n: number, call: unknown[]) => n + (call[0] as unknown[]).length, 0)
    }
    constructor(public options: FakePlayer['options']) {
      players.push(this as unknown as FakePlayer)
    }
  },
}))

import { readAloud, useReadAloud, useSpokenWordHighlight, useIsVoiceReading, voiceStreamId } from './use-read-aloud'

function tokenResponse(body: unknown, ok = true) {
  return { ok, json: async () => body }
}

describe('readAloud controller', () => {
  beforeEach(() => {
    players.length = 0
    apiFetch.mockReset()
    createTtsAdapter.mockClear()
    readAloud.stop()
  })

  it('fetches credentials, then speaks the message through a player', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'aura-2-luna-en', speed: 1.2 }))
    const speaking = readAloud.speak('m1', 'Hello **world**. Bye.')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'm1', status: 'connecting', error: null, errorId: null })
    await speaking

    expect(apiFetch).toHaveBeenCalledWith('/api/voice/tts-token')
    expect(createTtsAdapter).toHaveBeenCalledWith('deepgram')
    const player = players[0]
    expect(player.options).toMatchObject({ token: 'jwt', voice: { voice: 'aura-2-luna-en', speed: 1.2 } })
    expect(player.start).toHaveBeenCalledTimes(1)
    expect(player.append.mock.calls[0][0].map((w: { text: string }) => w.text)).toEqual(['Hello', 'world.', 'Bye.'])
    expect(player.end).toHaveBeenCalledTimes(1)
    expect(readAloud.getPlayer()).toBe(player)

    player.options.onStatus?.('speaking')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'm1', status: 'speaking', error: null, errorId: null })
    player.options.onStatus?.('done')
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: null, errorId: null })
    expect(readAloud.getPlayer()).toBeNull()
  })

  it('stop() halts the player and goes idle', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    await readAloud.speak('m1', 'Hello there.')
    readAloud.stop()
    expect(players[0].stop).toHaveBeenCalledTimes(1)
    expect(readAloud.getSnapshot().activeId).toBeNull()
    // a late status from the stopped player is ignored
    players[0].options.onStatus?.('error', new Error('late'))
    expect(readAloud.getSnapshot().error).toBeNull()
  })

  it('speaking another message stops the current one', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    await readAloud.speak('m1', 'First.')
    await readAloud.speak('m2', 'Second.')
    expect(players[0].stop).toHaveBeenCalledTimes(1)
    expect(readAloud.getPlayer()).toBe(players[1])
    expect(readAloud.getSnapshot().activeId).toBe('m2')
  })

  it('does not start a player when the user moved on during the token round-trip', async () => {
    let resolve!: (v: unknown) => void
    apiFetch.mockReturnValue(new Promise((r) => { resolve = r }))
    const speaking = readAloud.speak('m1', 'Hello.')
    readAloud.stop()
    resolve(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    await speaking
    expect(players).toHaveLength(0)
    expect(readAloud.getSnapshot().activeId).toBeNull()
  })

  it('pause and resume go to the player, and its paused status shows in the snapshot', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    await readAloud.speak('m1', 'Hello there.')
    readAloud.pause()
    expect(players[0].pause).toHaveBeenCalledTimes(1)
    players[0].options.onStatus?.('paused')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'm1', status: 'paused', error: null, errorId: null })
    readAloud.resume()
    expect(players[0].resume).toHaveBeenCalledTimes(1)
    players[0].options.onStatus?.('speaking')
    expect(readAloud.getSnapshot().status).toBe('speaking')
  })

  it('restart() re-fetches credentials and resumes from the word being spoken', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    await readAloud.speak('m1', 'One two three. Four five six.')
    players[0].getWordCursor.mockReturnValue(3.6)
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt2', voice: 'v', speed: 1.3 }))
    readAloud.restart()
    await new Promise((r) => setTimeout(r, 0))
    expect(players[0].stop).toHaveBeenCalledTimes(1)
    const next = players[1]
    expect(next.options).toMatchObject({ token: 'jwt2', voice: { voice: 'v', speed: 1.3 }, firstWordIndex: 3 })
    expect(next.append.mock.calls[0][0].map((w: { text: string }) => w.text)).toEqual(['Four', 'five', 'six.'])
    expect(readAloud.getSnapshot().activeId).toBe('m1')
    // nothing to restart once stopped
    readAloud.stop()
    readAloud.restart()
    await new Promise((r) => setTimeout(r, 0))
    expect(players).toHaveLength(2)
  })

  it('restart() after playback finished does nothing (no replay from the top)', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    await readAloud.speak('m1', 'One two three.')
    players[0].options.onStatus?.('done')
    readAloud.restart()
    await new Promise((r) => setTimeout(r, 0))
    expect(players).toHaveLength(1)
    expect(readAloud.getSnapshot().activeId).toBeNull()
  })

  it('restart() while paused carries on paused at the new speed', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    await readAloud.speak('m1', 'One two three. Four five six.')
    players[0].status = 'paused'
    players[0].getWordCursor.mockReturnValue(2)
    readAloud.restart()
    await new Promise((r) => setTimeout(r, 0))
    const next = players[1]
    expect(next.options.firstWordIndex).toBe(2)
    next.options.onStatus?.('speaking')
    expect(next.pause).toHaveBeenCalledTimes(1)
    next.options.onStatus?.('paused')
    expect(readAloud.getSnapshot().status).toBe('paused')
  })

  it('surfaces credential and playback failures', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ error: 'No voice provider configured' }, false))
    await readAloud.speak('m1', 'Hello.')
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: 'No voice provider configured', errorId: 'm1' })

    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await readAloud.speak('m2', 'Hello.')
    expect(readAloud.getSnapshot().error).toBeNull() // cleared on the next play
    players[0].options.onStatus?.('error', new Error('socket died'))
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: 'socket died', errorId: 'm2' })
    errorSpy.mockRestore()
  })
})

describe('useReadAloud', () => {
  beforeEach(() => {
    players.length = 0
    apiFetch.mockReset()
    readAloud.stop()
  })

  it('reports status for its own message only and toggles play/stop', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    const { result } = renderHook(() => useReadAloud('m1', 'Hello.'))
    const other = renderHook(() => useReadAloud('m2', 'Other.'))
    expect(result.current.status).toBe('idle')

    await act(async () => { result.current.toggle() })
    expect(result.current.status).toBe('connecting')
    expect(other.result.current.status).toBe('idle')

    act(() => { players[0].options.onStatus?.('speaking') })
    expect(result.current.status).toBe('speaking')
    expect(result.current.isActive).toBe(true)

    act(() => { result.current.toggle() })
    expect(players[0].stop).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('shows a failure on the message it happened to, even though it is idle again', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ error: 'Deepgram key revoked' }, false))
    const { result } = renderHook(() => useReadAloud('m1', 'Hello.'))
    const other = renderHook(() => useReadAloud('m2', 'Other.'))
    await act(async () => { result.current.toggle() })
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBe('Deepgram key revoked')
    expect(other.result.current.error).toBeNull()
    // the next play clears it
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    await act(async () => { result.current.toggle() })
    expect(result.current.error).toBeNull()
  })
})

describe('useSpokenWordHighlight', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    readAloud.stop()
  })

  const runFrame = () => { const cb = frames.pop()!; frames.length = 0; cb(0) }

  it('lights the words at or below the cursor, including repeated indices, and clears on stop', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<span data-spoken-word="0">Hi</span>',
      '<b><span data-spoken-word="1">there</span></b><span data-spoken-word="1">,</span>',
      '<span data-spoken-word="2">friend</span>',
    ].join(' ')
    const cursor = vi.fn(() => -1)
    vi.spyOn(readAloud, 'getPlayer').mockReturnValue({ getWordCursor: cursor } as never)
    const { rerender, unmount } = renderHook(({ active }) => {
      const ref = useRef<HTMLElement | null>(root)
      useSpokenWordHighlight(ref, active)
    }, { initialProps: { active: true } })

    const lit = () => Array.from(root.querySelectorAll('[data-spoken]')).map((s) => s.textContent)
    runFrame()
    expect(lit()).toEqual([])
    cursor.mockReturnValue(1.4)
    runFrame()
    expect(lit()).toEqual(['Hi', 'there', ','])
    cursor.mockReturnValue(0)
    runFrame()
    expect(lit()).toEqual(['Hi'])
    cursor.mockReturnValue(5)
    runFrame()
    expect(lit()).toEqual(['Hi', 'there', ',', 'friend'])

    rerender({ active: false })
    expect(lit()).toEqual([])
    expect(cancelAnimationFrame).toHaveBeenCalled()
    unmount()
  })
})

describe('readAloud streaming', () => {
  const credentials = tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 })
  const spoken = (player: FakePlayer, call = 0) => player.append.mock.calls[call][0].map((w: { text: string }) => w.text)

  beforeEach(() => {
    players.length = 0
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(credentials)
    readAloud.stop()
  })

  async function tick() {
    await new Promise((r) => setTimeout(r, 0))
  }

  // First, while no credentials are cached from an earlier read.
  it('a refused credential fetch fails the stream under its id', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ error: 'No speech in tests' }, false))
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'Hello there. ')
    await tick()
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: 'No speech in tests', errorId: 'v' })
  })

  it("speaks a streaming reply's settled words as they arrive, and the rest at the end", async () => {
    readAloud.beginStream('v')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'v', status: 'connecting', error: null, errorId: null })
    expect(players).toHaveLength(0)

    readAloud.pushStream('v', 'Hello there. How are')
    await tick()
    expect(players).toHaveLength(1)
    expect(players[0].start).toHaveBeenCalledTimes(1)
    expect(spoken(players[0])).toEqual(['Hello', 'there.'])

    readAloud.pushStream('v', 'Hello there. How are you? Fine')
    expect(spoken(players[0], 1)).toEqual(['How', 'are', 'you?'])
    expect(players[0].end).not.toHaveBeenCalled()

    readAloud.endStream('v')
    expect(spoken(players[0], 2)).toEqual(['Fine'])
    expect(players[0].end).toHaveBeenCalledTimes(1)

    players[0].options.onStatus?.('speaking')
    expect(readAloud.getSnapshot().status).toBe('speaking')
    players[0].options.onStatus?.('done')
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: null, errorId: null })
  })

  it("a new segment flushes the previous message's unfinished tail first", async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two')
    await tick()
    expect(players).toHaveLength(0) // nothing settled yet

    readAloud.nextStreamSegment('v')
    await tick()
    expect(spoken(players[0])).toEqual(['One', 'two'])

    readAloud.pushStream('v', 'Three four.')
    expect(players[0].append).toHaveBeenCalledTimes(1)
    readAloud.endStream('v')
    expect(spoken(players[0], 1)).toEqual(['Three', 'four.'])
    expect(players[0].end).toHaveBeenCalledTimes(1)
  })

  it('an idle close between segments opens a fresh player for the words that follow, on the same credentials', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'First part. ')
    await tick()
    expect(spoken(players[0])).toEqual(['First', 'part.'])
    expect(players[0].options).toMatchObject({ finishOnIdleClose: true })

    players[0].options.onStatus?.('speaking')
    players[0].options.onStatus?.('done')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'v', status: 'connecting', error: null, errorId: null })

    readAloud.pushStream('v', 'First part. Second part. ')
    await tick()
    expect(players).toHaveLength(2)
    expect(spoken(players[1])).toEqual(['Second', 'part.'])
    // Credentials are kept across the players of one read (and, being
    // short-lived, across reads for a few minutes), so none is fetched here.
    expect(apiFetch.mock.calls.length).toBeLessThanOrEqual(1)

    readAloud.endStream('v')
    expect(players[1].end).toHaveBeenCalledTimes(1)
    players[1].options.onStatus?.('done')
    expect(readAloud.getSnapshot().activeId).toBeNull()
  })

  it('words that arrive while an idle-closed player plays out wait for the next player, and are not lost', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'First part. ')
    await tick()
    expect(spoken(players[0])).toEqual(['First', 'part.'])
    players[0].options.onStatus?.('speaking')
    // The synthesizer idle-closed; the player is still speaking its buffer
    // and no longer takes words.
    ;(players[0] as unknown as { acceptsWords: boolean }).acceptsWords = false
    readAloud.pushStream('v', 'First part. Second part. ')
    expect(players[0].append).toHaveBeenCalledTimes(1)
    expect(players).toHaveLength(1)
    // The turn ends while it is still playing out.
    readAloud.endStream('v')
    expect(readAloud.getSnapshot().activeId).toBe('v')
    players[0].options.onStatus?.('done')
    await tick()
    expect(players).toHaveLength(2)
    expect(spoken(players[1])).toEqual(['Second', 'part.'])
    expect(players[1].end).toHaveBeenCalledTimes(1)
    players[1].options.onStatus?.('done')
    expect(readAloud.getSnapshot().activeId).toBeNull()
  })

  it('ending a stream that never had a player settles at once', () => {
    readAloud.beginStream('v')
    readAloud.endStream('v')
    expect(readAloud.getSnapshot().activeId).toBeNull()
  })

  it('stop() abandons the stream and later pushes are ignored', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'Hello there. ')
    await tick()
    readAloud.stop()
    expect(players[0].stop).toHaveBeenCalledTimes(1)
    expect(readAloud.getSnapshot().activeId).toBeNull()
    readAloud.pushStream('v', 'Hello there. More. ')
    await tick()
    expect(players).toHaveLength(1)
  })

  it('a player failure mid-stream is retried once, then gives up', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'Hello there. ')
    await tick()
    players[0].options.onStatus?.('error', new Error('boom'))
    expect(readAloud.getSnapshot().activeId).toBe('v')
    await tick()
    expect(players).toHaveLength(2)
    readAloud.pushStream('v', 'Hello there. Again. ')
    players[1].options.onStatus?.('error', new Error('boom again'))
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: 'boom again', errorId: 'v' })
  })

  it('a player that spoke resets the failure count: a later failure is retried again', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. ')
    await tick()
    players[0].options.onStatus?.('error', new Error('boom'))
    await tick()
    expect(players).toHaveLength(2)
    players[1].options.onStatus?.('speaking')
    players[1].getWordCursor.mockReturnValue(3)
    readAloud.pushStream('v', 'One two three. Four five six. ')
    players[1].options.onStatus?.('error', new Error('boom again'))
    // Not the end of the reply: a fresh player takes the rest.
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'v', status: 'connecting', error: null, errorId: null })
    await tick()
    expect(players).toHaveLength(3)
    expect(spoken(players[2])).toEqual(['Four', 'five', 'six.'])
  })

  it('a failed player\'s unspoken words are said by the next one, on fresh credentials', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. Four five six. Seven eight nine. ')
    await tick()
    expect(spoken(players[0])).toHaveLength(9)
    players[0].options.onStatus?.('speaking')
    players[0].getWordCursor.mockReturnValue(4.2) // in the middle of "five"
    apiFetch.mockClear()
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'fresh', voice: 'v', speed: 1 }))
    players[0].options.onStatus?.('error', new Error('connection closed before the reply finished'))
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'v', status: 'connecting', error: null, errorId: null })
    expect(readAloud.getStreamWordCursor()).toBe(3)
    await tick()
    expect(players).toHaveLength(2)
    expect(players[1].options.token).toBe('fresh')
    expect(spoken(players[1])).toEqual(['five', 'six.', 'Seven', 'eight', 'nine.'])
    players[1].getWordCursor.mockReturnValue(2)
    expect(readAloud.getStreamWordCursor()).toBe(6)
  })

  it('a failure after the turn ended still gets one retry, and the tail is not lost', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. Four five six. ')
    readAloud.endStream('v')
    await tick()
    players[0].getWordCursor.mockReturnValue(2)
    players[0].options.onStatus?.('error', new Error('boom'))
    await tick()
    expect(players).toHaveLength(2)
    expect(spoken(players[1])).toEqual(['three.', 'Four', 'five', 'six.'])
    expect(players[1].end).toHaveBeenCalledTimes(1)
    players[1].options.onStatus?.('done')
    expect(readAloud.getSnapshot().activeId).toBeNull()
  })

  it('a failure with nothing left to say after the turn ended settles quietly', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. ')
    readAloud.endStream('v')
    await tick()
    players[0].getWordCursor.mockReturnValue(3)
    players[0].options.onStatus?.('error', new Error('boom'))
    expect(players).toHaveLength(1)
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: null, errorId: null })
  })
})

describe('readAloud streaming restart (a speed change)', () => {
  const spoken = (player: FakePlayer, call = 0) => player.append.mock.calls[call][0].map((w: { text: string }) => w.text)
  beforeEach(() => {
    players.length = 0
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    readAloud.stop()
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('re-queues the unspoken tail on a fresh player with fresh credentials, keeping the cursor', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. Four five six. ')
    await tick()
    expect(spoken(players[0])).toEqual(['One', 'two', 'three.', 'Four', 'five', 'six.'])
    players[0].options.onStatus?.('speaking')
    players[0].getWordCursor.mockReturnValue(2.4) // saying "three."

    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt2', voice: 'v', speed: 1.3 }))
    readAloud.restart()
    expect(players[0].stop).toHaveBeenCalledTimes(1)
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'v', status: 'connecting', error: null, errorId: null })
    // The words the old player said stay counted while the new one opens.
    expect(readAloud.getStreamWordCursor()).toBe(1)
    await tick()
    expect(players).toHaveLength(2)
    expect(players[1].options).toMatchObject({ token: 'jwt2', voice: { speed: 1.3 } })
    // The word being spoken is said again, then the rest.
    expect(spoken(players[1])).toEqual(['three.', 'Four', 'five', 'six.'])
    players[1].getWordCursor.mockReturnValue(1)
    expect(readAloud.getStreamWordCursor()).toBe(3)

    // Text that arrives after carries on with the new player.
    readAloud.pushStream('v', 'One two three. Four five six. Seven eight. ')
    expect(spoken(players[1], 1)).toEqual(['Seven', 'eight.'])
    readAloud.endStream('v')
    expect(players[1].end).toHaveBeenCalledTimes(1)
  })

  it('restart() between replies drops the cached credentials, so the next reply opens on the new speed', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. ')
    readAloud.endStream('v')
    await tick()
    players[0].options.onStatus?.('done')
    expect(readAloud.getSnapshot().activeId).toBeNull()
    // A second reply, with nothing changed, reuses the credentials.
    apiFetch.mockClear()
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'Four five six. ')
    readAloud.endStream('v')
    await tick()
    expect(apiFetch).not.toHaveBeenCalled()
    players[1].options.onStatus?.('done')

    // The person's turn: nothing is playing when they pick a new speed.
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt2', voice: 'v', speed: 1.3 }))
    readAloud.restart()
    expect(players).toHaveLength(2)

    readAloud.beginStream('v')
    readAloud.pushStream('v', 'Seven eight nine. ')
    await tick()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(players[2].options).toMatchObject({ token: 'jwt2', voice: { speed: 1.3 } })
  })

  it('a restart while credentials are in flight keeps the stale ones out of the cache', async () => {
    readAloud.restart() // nothing cached from an earlier reply
    let resolveToken: (r: unknown) => void = () => {}
    apiFetch.mockReturnValue(new Promise((r) => { resolveToken = r }))
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two three. ')
    await tick()
    expect(players).toHaveLength(0)
    readAloud.restart()
    resolveToken(tokenResponse({ provider: 'deepgram', token: 'old', voice: 'v', speed: 1 }))
    await tick()
    // This reply opens on what came back; the next one does not reuse it.
    expect(players).toHaveLength(1)
    readAloud.endStream('v')
    players[0].options.onStatus?.('done')
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'new', voice: 'v', speed: 1.3 }))
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'Four five six. ')
    await tick()
    expect(players[1].options).toMatchObject({ token: 'new', voice: { speed: 1.3 } })
  })

  it('places a message that started on the old player, and one still pending', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two. ')
    await tick()
    readAloud.nextStreamSegment('v')
    readAloud.pushStream('v', 'Three four. ')
    expect(players[0].totalWords).toBe(4)
    // Still in the first message: the second has not been reached.
    players[0].getWordCursor.mockReturnValue(0.5)
    readAloud.restart()
    await tick()
    expect(spoken(players[1])).toEqual(['One', 'two.', 'Three', 'four.'])
    players[1].getWordCursor.mockReturnValue(2.5)
    expect(readAloud.getStreamWordCursor()).toBe(0.5)

    // A third message queued while nothing is open: it keeps its place behind the tail.
    readAloud.nextStreamSegment('v')
    readAloud.pushStream('v', 'Five six. ')
    expect(spoken(players[1], 1)).toEqual(['Five', 'six.'])
    players[1].getWordCursor.mockReturnValue(4.5)
    expect(readAloud.getStreamWordCursor()).toBe(0.5)
  })

  it('with nothing open, only the credentials are dropped', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two. ')
    await tick()
    players[0].options.onStatus?.('speaking')
    players[0].getWordCursor.mockReturnValue(2)
    players[0].options.onStatus?.('done') // idle close: nothing open
    apiFetch.mockClear()
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt3', voice: 'v', speed: 0.9 }))
    readAloud.restart()
    expect(players).toHaveLength(1)
    readAloud.pushStream('v', 'One two. Three four. ')
    await tick()
    expect(players[1].options).toMatchObject({ token: 'jwt3', voice: { speed: 0.9 } })
    expect(spoken(players[1])).toEqual(['Three', 'four.'])
  })

  it('isAudible() follows the open player', async () => {
    expect(readAloud.isAudible()).toBe(false)
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two. ')
    await tick()
    ;(players[0] as unknown as { isAudible: boolean }).isAudible = true
    expect(readAloud.isAudible()).toBe(true)
    readAloud.stop()
    expect(readAloud.isAudible()).toBe(false)
  })
})

describe('readAloud streaming volume', () => {
  beforeEach(() => {
    players.length = 0
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    readAloud.stop()
  })

  it('ducks the open player, and any player opened while ducked', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'First part. ')
    await new Promise((r) => setTimeout(r, 0))
    readAloud.duckStream('v', true)
    expect(players[0].setVolume).toHaveBeenLastCalledWith(0.15)
    // An idle close and a fresh player: still ducked.
    players[0].options.onStatus?.('done')
    readAloud.pushStream('v', 'First part. Second part. ')
    await new Promise((r) => setTimeout(r, 0))
    expect(players[1].setVolume).toHaveBeenCalledWith(0.15)
    readAloud.duckStream('v', false)
    expect(players[1].setVolume).toHaveBeenLastCalledWith(1)
    // Another read's id is ignored.
    readAloud.duckStream('other', true)
    expect(players[1].setVolume).toHaveBeenCalledTimes(2)
  })
})

describe('readAloud streaming word cursor', () => {
  beforeEach(() => {
    players.length = 0
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v', speed: 1 }))
    readAloud.stop()
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('counts words per message across segments and across players', async () => {
    readAloud.beginStream('v')
    expect(readAloud.getStreamWordCursor()).toBe(-1)
    readAloud.pushStream('v', 'One two. Three four. ')
    await tick()
    players[0].getWordCursor.mockReturnValue(1.5)
    expect(readAloud.getStreamWordCursor()).toBe(1.5)

    // The next assistant message: its words start over at 0 for the highlight.
    readAloud.nextStreamSegment('v')
    readAloud.pushStream('v', 'Five six. ')
    expect(players[0].totalWords).toBe(6)
    players[0].getWordCursor.mockReturnValue(4.5)
    expect(readAloud.getStreamWordCursor()).toBe(0.5)

    // An idle close mid-message: the words this player said stay counted.
    players[0].getWordCursor.mockReturnValue(6)
    players[0].options.onStatus?.('done')
    expect(readAloud.getStreamWordCursor()).toBe(1)
    readAloud.pushStream('v', 'Five six. Seven eight. ')
    await tick()
    expect(readAloud.getStreamWordCursor()).toBe(1)
    players[1].getWordCursor.mockReturnValue(0.5)
    expect(readAloud.getStreamWordCursor()).toBe(2.5)
  })

  it('places a message that began before its player opened', async () => {
    readAloud.beginStream('v')
    readAloud.pushStream('v', 'One two')
    readAloud.nextStreamSegment('v') // 'One two' still pending, no player yet
    readAloud.pushStream('v', 'Three four. ')
    await tick()
    expect(players[0].totalWords).toBe(4)
    players[0].getWordCursor.mockReturnValue(2)
    expect(readAloud.getStreamWordCursor()).toBe(0)
  })

  it('useIsVoiceReading answers for the session being read', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | undefined }) => useIsVoiceReading(id), { initialProps: { id: 's1' as string | undefined } })
    expect(result.current).toBe(false)
    act(() => readAloud.beginStream(voiceStreamId('s1')))
    expect(result.current).toBe(true)
    rerender({ id: 's2' })
    expect(result.current).toBe(false)
    rerender({ id: undefined })
    expect(result.current).toBe(false)
  })
})

describe('useSpokenWordHighlight with a custom cursor and live spans', () => {
  let frames: FrameRequestCallback[]
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const runFrame = () => { const cb = frames.pop()!; frames.length = 0; cb(0) }

  it('follows the given cursor and picks up spans added after mount', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<span data-spoken-word="0">Hi</span> <span data-spoken-word="1">there</span>'
    let cursor = 0
    const getCursor = () => cursor
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(root)
      useSpokenWordHighlight(ref, true, { getCursor, live: true })
    })
    const lit = () => Array.from(root.querySelectorAll('[data-spoken]')).map((s) => s.textContent)
    runFrame()
    expect(lit()).toEqual(['Hi'])

    // The tail re-renders with more words.
    root.innerHTML = '<span data-spoken-word="0">Hi</span> <span data-spoken-word="1">there</span> <span data-spoken-word="2">friend</span>'
    await new Promise((r) => setTimeout(r, 0)) // the observer callback
    cursor = 2
    runFrame()
    expect(lit()).toEqual(['Hi', 'there', 'friend'])
  })
})
