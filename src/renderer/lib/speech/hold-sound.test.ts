import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@renderer/assets/voice-hold.mp3', () => ({ default: '/voice-hold.mp3' }))

import { HoldSound, HOLD_VOLUME, HOLD_RETRY_AFTER_MS, type HoldSoundAudio } from './hold-sound'

class FakeAudio implements HoldSoundAudio {
  loop = false
  volume = 1
  currentTime = 0
  paused = true
  playResult: Promise<void> = Promise.resolve()
  play = vi.fn(() => {
    this.paused = false
    return this.playResult
  })
  pause = vi.fn(() => {
    this.paused = true
  })
}

describe('HoldSound', () => {
  let audios: FakeAudio[]
  let sound: HoldSound

  beforeEach(() => {
    vi.useFakeTimers()
    audios = []
    sound = new HoldSound({
      createAudio: () => {
        const audio = new FakeAudio()
        audios.push(audio)
        return audio
      },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loops the sound from the start, fading in', () => {
    sound.start()
    expect(sound.isPlaying).toBe(true)
    expect(audios).toHaveLength(1)
    const audio = audios[0]
    expect(audio.loop).toBe(true)
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(audio.volume).toBe(0)
    vi.advanceTimersByTime(450)
    expect(audio.volume).toBeGreaterThan(HOLD_VOLUME * 0.3)
    expect(audio.volume).toBeLessThan(HOLD_VOLUME)
    vi.advanceTimersByTime(600)
    expect(audio.volume).toBeCloseTo(HOLD_VOLUME)
  })

  it('fades out on stop, then pauses and rewinds; one element is reused', () => {
    sound.start()
    vi.advanceTimersByTime(1000)
    const audio = audios[0]
    audio.currentTime = 12.5
    sound.stop()
    expect(sound.isPlaying).toBe(false)
    // Still audible during the fade.
    expect(audio.pause).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(audio.volume).toBeLessThan(HOLD_VOLUME)
    expect(audio.volume).toBeGreaterThan(0)
    vi.advanceTimersByTime(300)
    expect(audio.volume).toBe(0)
    expect(audio.pause).toHaveBeenCalledTimes(1)
    expect(audio.currentTime).toBe(0)

    sound.start()
    expect(audios).toHaveLength(1)
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('a stop during the fade-in turns straight around', () => {
    sound.start()
    vi.advanceTimersByTime(300)
    const audio = audios[0]
    const mid = audio.volume
    sound.stop()
    vi.advanceTimersByTime(80)
    expect(audio.volume).toBeLessThan(mid)
    vi.advanceTimersByTime(400)
    expect(audio.pause).toHaveBeenCalledTimes(1)
  })

  it('start() twice is one play; stop() when silent is nothing', () => {
    sound.start()
    sound.start()
    expect(audios[0].play).toHaveBeenCalledTimes(1)
    sound.stop()
    vi.advanceTimersByTime(500)
    sound.stop()
    expect(audios[0].pause).toHaveBeenCalledTimes(1)
  })

  it('a refused play() leaves the sound not playing', async () => {
    const refused = new HoldSound({
      createAudio: () => {
        const audio = new FakeAudio()
        audio.playResult = Promise.reject(new Error('NotAllowedError'))
        audios.push(audio)
        return audio
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    refused.start()
    expect(refused.isPlaying).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(refused.isPlaying).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)

    // Asked again at once (the poll does, every 200 ms): not retried yet.
    refused.start()
    expect(audios[0].play).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOLD_RETRY_AFTER_MS)
    refused.start()
    expect(audios[0].play).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('a stop() before play() got going is not a failure, and does not block the next start', async () => {
    const audio = new FakeAudio()
    const abort = Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' })
    audio.playResult = Promise.reject(abort)
    const cut = new HoldSound({ createAudio: () => audio })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cut.start()
    cut.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).not.toHaveBeenCalled()
    audio.playResult = Promise.resolve()
    cut.start()
    expect(audio.play).toHaveBeenCalledTimes(2)
    expect(cut.isPlaying).toBe(true)
    warn.mockRestore()
  })

  it('does nothing where there is no audio element', () => {
    const silent = new HoldSound({ createAudio: () => null })
    silent.start()
    expect(silent.isPlaying).toBe(false)
    silent.stop()
  })

  it('prime() creates the element without playing it', () => {
    sound.prime()
    expect(audios).toHaveLength(1)
    expect(audios[0].play).not.toHaveBeenCalled()
    sound.start()
    expect(audios).toHaveLength(1)
  })
})
