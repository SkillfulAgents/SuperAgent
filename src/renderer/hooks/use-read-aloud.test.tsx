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
  getWordCursor: ReturnType<typeof vi.fn>
}
const players: FakePlayer[] = []
vi.mock('@renderer/lib/speech/speech-player', () => ({
  SpeechPlayer: class {
    status = 'speaking'
    start = vi.fn()
    append = vi.fn()
    end = vi.fn()
    stop = vi.fn()
    pause = vi.fn()
    resume = vi.fn()
    getWordCursor = vi.fn(() => -1)
    constructor(public options: FakePlayer['options']) {
      players.push(this as unknown as FakePlayer)
    }
  },
}))

import { readAloud, useReadAloud, useSpokenWordHighlight } from './use-read-aloud'

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
