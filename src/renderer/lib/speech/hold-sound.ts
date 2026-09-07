import holdSoundUrl from '@renderer/assets/voice-hold.mp3'

/** The part of a media element the loop needs; injectable for tests. */
export interface HoldSoundAudio {
  loop: boolean
  volume: number
  currentTime: number
  play(): Promise<void> | void
  pause(): void
}

/** Loudness of the loop: well under a voice, a presence rather than music. */
export const HOLD_VOLUME = 0.12
const FADE_IN_MS = 900
const FADE_OUT_MS = 400
const FADE_STEP_MS = 40
/** After a refused play(), no retry for this long: the poll would ask every 200 ms. */
export const HOLD_RETRY_AFTER_MS = 30_000

function createDefaultAudio(): HoldSoundAudio | null {
  if (typeof Audio === 'undefined') return null
  const audio = new Audio(holdSoundUrl)
  audio.preload = 'auto'
  return audio
}

/**
 * The soft loop voice mode plays while the agent works, so a long silence
 * never reads as a dropped call. A media element rather than Web Audio: it
 * plays from any origin the app is served from (fetch() cannot read the
 * packaged file:// bundle), and Chromium loops an MP3 without a gap. Fades
 * in and out so it never cuts across the reply's first word; each hold
 * starts the loop from its beginning.
 */
export class HoldSound {
  private audio: HoldSoundAudio | null = null
  private readonly createAudio: () => HoldSoundAudio | null
  private fadeTimer: ReturnType<typeof setInterval> | null = null
  private playing = false
  private retryAt = 0

  constructor(options: { createAudio?: () => HoldSoundAudio | null } = {}) {
    this.createAudio = options.createAudio ?? createDefaultAudio
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /** Create the element (and start its download) ahead of the first hold. */
  prime(): void {
    this.audio ??= this.createAudio()
  }

  start(): void {
    if (this.playing || Date.now() < this.retryAt) return
    this.prime()
    const audio = this.audio
    if (!audio) return
    this.playing = true
    audio.loop = true
    audio.volume = 0
    audio.currentTime = 0
    let played: Promise<void> | void
    try {
      played = audio.play()
    } catch (err) {
      this.playing = false
      console.warn('Hold sound could not play:', err)
      return
    }
    if (played) {
      played.catch((err: unknown) => {
        // Cut by stop() before it got going: not a failure.
        if ((err as { name?: string } | null)?.name === 'AbortError') return
        // Autoplay refused, or no decoder for the file: silence is fine,
        // and asking again right away would only be refused again.
        console.warn('Hold sound could not play:', err)
        this.playing = false
        this.retryAt = Date.now() + HOLD_RETRY_AFTER_MS
      })
    }
    this.fadeTo(audio, HOLD_VOLUME, FADE_IN_MS, null)
  }

  stop(): void {
    if (!this.playing) return
    this.playing = false
    const audio = this.audio
    if (!audio) return
    this.fadeTo(audio, 0, FADE_OUT_MS, () => {
      audio.pause()
      audio.currentTime = 0
    })
  }

  private fadeTo(audio: HoldSoundAudio, target: number, durationMs: number, done: (() => void) | null): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer)
    const from = audio.volume
    const startedAt = Date.now()
    this.fadeTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - startedAt) / durationMs)
      audio.volume = Math.min(1, Math.max(0, from + (target - from) * t))
      if (t >= 1) {
        if (this.fadeTimer) clearInterval(this.fadeTimer)
        this.fadeTimer = null
        done?.()
      }
    }, FADE_STEP_MS)
  }
}

export const holdSound = new HoldSound()
