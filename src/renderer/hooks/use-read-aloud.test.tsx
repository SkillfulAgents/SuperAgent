// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'

const apiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const createTtsAdapter = vi.fn((_provider: string) => ({ fake: 'adapter' }))
vi.mock('@renderer/lib/tts', () => ({ createTtsAdapter: (provider: string) => createTtsAdapter(provider) }))

interface FakePlayer {
  options: { adapter: unknown; token: string; voice: string; onStatus?: (s: string, e?: Error) => void }
  start: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getWordCursor: ReturnType<typeof vi.fn>
}
const players: FakePlayer[] = []
vi.mock('@renderer/lib/speech/speech-player', () => ({
  SpeechPlayer: class {
    start = vi.fn()
    append = vi.fn()
    end = vi.fn()
    stop = vi.fn()
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
    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'aura-2-luna-en' }))
    const speaking = readAloud.speak('m1', 'Hello **world**. Bye.')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'm1', status: 'connecting', error: null })
    await speaking

    expect(apiFetch).toHaveBeenCalledWith('/api/stt/tts-token')
    expect(createTtsAdapter).toHaveBeenCalledWith('deepgram')
    const player = players[0]
    expect(player.options).toMatchObject({ token: 'jwt', voice: 'aura-2-luna-en' })
    expect(player.start).toHaveBeenCalledTimes(1)
    expect(player.append.mock.calls[0][0].map((w: { text: string }) => w.text)).toEqual(['Hello', 'world.', 'Bye.'])
    expect(player.end).toHaveBeenCalledTimes(1)
    expect(readAloud.getPlayer()).toBe(player)

    player.options.onStatus?.('speaking')
    expect(readAloud.getSnapshot()).toEqual({ activeId: 'm1', status: 'speaking', error: null })
    player.options.onStatus?.('done')
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: null })
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

  it('surfaces credential and playback failures', async () => {
    apiFetch.mockResolvedValue(tokenResponse({ error: 'No voice provider configured' }, false))
    await readAloud.speak('m1', 'Hello.')
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: 'No voice provider configured' })

    apiFetch.mockResolvedValue(tokenResponse({ provider: 'deepgram', token: 'jwt', voice: 'v' }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await readAloud.speak('m2', 'Hello.')
    expect(readAloud.getSnapshot().error).toBeNull() // cleared on the next play
    players[0].options.onStatus?.('error', new Error('socket died'))
    expect(readAloud.getSnapshot()).toEqual({ activeId: null, status: 'idle', error: 'socket died' })
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
