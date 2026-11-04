// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.apiFetch }))
import { SPEECH_PIECES_PER_REQUEST, SPEECH_RELAY_INTERVAL_MS, useMeetingSpeechRelay } from './use-meeting-speech-relay'

const T0 = Date.parse('2026-11-04T10:05:10Z')
type Sent = { path: string; sentAt: number; pieces: Array<{ at: number; role: string; text: string }>; keepalive: boolean }
const sent = (): Sent[] => mocks.apiFetch.mock.calls.map(([path, init]: [string, RequestInit]) => ({ path, ...JSON.parse(init.body as string), keepalive: init.keepalive }))
const heard = (text: string) => ({ role: 'user' as const, text })

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  mocks.apiFetch.mockReset()
  mocks.apiFetch.mockImplementation(async () => new Response('{"accepted":true}'))
})
afterEach(() => { vi.useRealTimers() })

describe('useMeetingSpeechRelay', () => {
  it("sends the call's speech to the meeting, in order and stamped with when it was heard, about once a second", async () => {
    const { result } = renderHook(() => useMeetingSpeechRelay('m 1', 't/1'))
    result.current(heard('What is wrong in this chart?'))
    await vi.advanceTimersByTimeAsync(400)
    result.current({ role: 'assistant', text: 'The Q3 bar is missing.' })
    await vi.advanceTimersByTimeAsync(SPEECH_RELAY_INTERVAL_MS - 400)
    expect(sent()).toEqual([{
      path: '/api/meeting-participant/m%201/speech?token=t%2F1', sentAt: T0 + 1000, keepalive: false,
      pieces: [{ at: T0, role: 'user', text: 'What is wrong in this chart?' }, { at: T0 + 400, role: 'assistant', text: 'The Q3 bar is missing.' }],
    }])
    // Nothing new was said, so nothing is sent.
    await vi.advanceTimersByTimeAsync(SPEECH_RELAY_INTERVAL_MS)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('sends a batch again while the host cannot take it, and drops a batch the host refuses', async () => {
    const { result } = renderHook(() => useMeetingSpeechRelay('m1', 't'))
    mocks.apiFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
    result.current(heard('Hello'))
    await vi.advanceTimersByTimeAsync(SPEECH_RELAY_INTERVAL_MS * 3)
    // Unreachable, then busy, then delivered: the same piece each time, then never again.
    expect(sent().map(request => request.pieces.map(piece => piece.text))).toEqual([['Hello'], ['Hello'], ['Hello']])
    mocks.apiFetch.mockResolvedValueOnce(new Response('', { status: 410 }))
    result.current(heard('After the end'))
    await vi.advanceTimersByTimeAsync(SPEECH_RELAY_INTERVAL_MS * 2)
    expect(sent().map(request => request.pieces.map(piece => piece.text))).toEqual([['Hello'], ['Hello'], ['Hello'], ['After the end']])
  })

  it('sends a backlog in requests of a bounded size, losing nothing', async () => {
    const { result } = renderHook(() => useMeetingSpeechRelay('m1', 't'))
    for (let i = 0; i <= SPEECH_PIECES_PER_REQUEST; i++) result.current(heard(` w${i}`))
    await vi.advanceTimersByTimeAsync(SPEECH_RELAY_INTERVAL_MS * 2)
    expect(sent().map(request => request.pieces.length)).toEqual([SPEECH_PIECES_PER_REQUEST, 1])
    expect(sent()[1].pieces[0].text).toBe(` w${SPEECH_PIECES_PER_REQUEST}`)
  })

  it('sends what is left when the page goes away, in a request that outlives the page', async () => {
    const { result, unmount } = renderHook(() => useMeetingSpeechRelay('m1', 't'))
    result.current(heard('Bye.'))
    unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toEqual([expect.objectContaining({ pieces: [{ at: T0, role: 'user', text: 'Bye.' }], keepalive: true })])
  })
})
