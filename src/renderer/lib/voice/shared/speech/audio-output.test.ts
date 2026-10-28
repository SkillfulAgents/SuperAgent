// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareSpeechAudioOutput } from './audio-output'

const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'
function setup(userAgent = safari) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] }
  const destination = { stream }
  const ctx = Object.assign(new EventTarget(), { state: 'running', destination: {}, createMediaStreamDestination: vi.fn(() => destination) })
  const audio = document.createElement('audio')
  const play = vi.fn(async () => {})
  const pause = vi.fn()
  audio.play = play
  audio.pause = pause
  vi.stubGlobal('Audio', function () { return audio })
  const close = () => { ctx.state = 'closed'; ctx.dispatchEvent(new Event('statechange')) }
  return { ctx: ctx as unknown as AudioContext, audio, play, pause, stop, destination, close }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
describe('speech output routing', () => {
  it('routes Safari through one media element, unlocked immediately and reused by the player', async () => {
    const { ctx, audio, play, destination, close } = setup()
    const output = prepareSpeechAudioOutput(ctx)
    expect(output.destination).toBe(destination)
    expect(audio.srcObject).toBe(destination.stream)
    expect(audio.isConnected).toBe(true)
    expect(play).toHaveBeenCalledOnce()
    expect(prepareSpeechAudioOutput(ctx)).toBe(output)
    await output.ready
    close()
  })
  it('retains the media output while paused and releases tracks and element on close', async () => {
    const { ctx, audio, pause, stop, close } = setup()
    await prepareSpeechAudioOutput(ctx).ready
    Object.assign(ctx, { state: 'suspended' })
    ctx.dispatchEvent(new Event('statechange'))
    expect(pause).not.toHaveBeenCalled()
    close(); close()
    expect(pause).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(audio.srcObject).toBeNull()
    expect(audio.isConnected).toBe(false)
  })
  it('pauses the media sink immediately and resumes the same stream', async () => {
    const { ctx, audio, play, pause, stop, destination, close } = setup()
    const output = prepareSpeechAudioOutput(ctx)
    await output.ready
    output.pause()
    expect(audio.muted).toBe(true)
    expect(pause).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
    await output.resume()
    expect(audio.muted).toBe(false)
    expect(audio.srcObject).toBe(destination.stream)
    expect(play).toHaveBeenCalledTimes(2)
    close()
  })
  it('ignores an interrupted play even if a newer resume is already in progress', async () => {
    const { ctx, play, close } = setup()
    let reject!: (error: Error) => void
    play.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const output = prepareSpeechAudioOutput(ctx)
    output.pause()
    await output.resume()
    reject(new DOMException('Paused', 'AbortError'))
    await expect(output.ready).resolves.toBeUndefined()
    close()
  })
  it('reports a rejected resume instead of silently advancing the reader', async () => {
    const { ctx, play, close } = setup()
    const output = prepareSpeechAudioOutput(ctx)
    await output.ready
    output.pause()
    play.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    await expect(output.resume()).rejects.toThrow('Audio playback was blocked by Safari')
    close()
  })
  it('surfaces autoplay denial when the player adopts the prepared output', async () => {
    const { ctx, play, close } = setup()
    play.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    const output = prepareSpeechAudioOutput(ctx)
    await expect(output.ready).rejects.toThrow('Audio playback was blocked by Safari')
    close()
  })
  it('ignores a pending play rejection after the context has been discarded', async () => {
    const { ctx, play, close } = setup()
    let reject!: (error: Error) => void
    play.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const output = prepareSpeechAudioOutput(ctx)
    close()
    reject(new DOMException('Stopped', 'AbortError'))
    await expect(output.ready).resolves.toBeUndefined()
  })
  it('uses direct Web Audio output on Chrome without a second playback path', async () => {
    const { ctx, play } = setup('Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36')
    expect(prepareSpeechAudioOutput(ctx).destination).toBe(ctx.destination)
    expect(ctx.createMediaStreamDestination).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
  })
})
