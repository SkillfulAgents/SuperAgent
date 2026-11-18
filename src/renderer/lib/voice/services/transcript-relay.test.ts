// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fetch = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/api', () => ({ apiFetch: fetch }))
import { VoiceTranscriptRelay } from './transcript-relay'
const batches = () => fetch.mock.calls.filter(([url]) => !url.endsWith('/transcripts')).map(([, init]) => JSON.parse(init.body))
let detach: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  fetch.mockReset().mockImplementation(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith('/transcripts')
    ? { id: JSON.parse(init.body as string).id, index: 0, path: '/workspace/sessions/s1/transcript-0.md' } : { accepted: true })))
})
afterEach(async () => { detach?.(); detach = undefined; await vi.advanceTimersByTimeAsync(0); vi.useRealTimers() })

describe('VoiceTranscriptRelay', () => {
  it('uses the shared endpoint and flushes speech on pagehide, including during a slow request', async () => {
    const relay = new VoiceTranscriptRelay('ada', 's1')
    const onError = vi.fn()
    detach = relay.attach(onError)
    await relay.start()
    let release!: (response: Response) => void
    fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    relay.append({ role: 'user', text: 'We ship' })
    await vi.advanceTimersByTimeAsync(1000)
    relay.append({ role: 'user', text: ' on Friday.' })
    window.dispatchEvent(new Event('pagehide'))
    expect(batches()).toHaveLength(2)
    release(new Response('{"accepted":true}'))
    await vi.advanceTimersByTimeAsync(0)
    expect(batches().map(batch => batch.pieces.map((piece: { text: string }) => piece.text))).toEqual([['We ship'], [' on Friday.']])
    expect(fetch.mock.calls.slice(1).every(([, init]) => init.keepalive)).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
  it('retains a failed batch and its timestamp, then drains the backlog in bounded requests', async () => {
    const relay = new VoiceTranscriptRelay('ada', 's1')
    await relay.start()
    relay.append({ role: 'user', text: '🙂'.repeat(20_000) })
    fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(relay.flush()).rejects.toThrow('offline')
    const failed = batches()[0]
    await vi.advanceTimersByTimeAsync(3000)
    await relay.flush()
    expect(batches()[1].pieces).toEqual(failed.pieces)
    const successful = batches().slice(1)
    expect(successful.flatMap(batch => batch.pieces.map((piece: { text: string }) => piece.text)).join('')).toBe('🙂'.repeat(20_000))
    expect(successful.every(batch => new TextEncoder().encode(JSON.stringify(batch)).byteLength < 25 * 1024)).toBe(true)
  })
  it('reuses allocation through effect detach/reattach and serializes competing flushes', async () => {
    const relay = new VoiceTranscriptRelay('ada', 's1')
    const first = await relay.start()
    relay.attach(vi.fn())()
    detach = relay.attach(vi.fn())
    expect(await relay.start()).toEqual(first)
    relay.append({ role: 'assistant', text: 'One answer' })
    await Promise.all([relay.flush(), relay.flush()])
    expect(batches()).toHaveLength(1)
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/transcripts'))).toHaveLength(1)
  })
})
