import type {
  NowPlayingPauseResult,
  NowPlayingPlayer,
  NowPlayingProbe,
  NowPlayingResumeOutcome,
  NowPlayingResumeResult,
} from '@shared/lib/voice/now-playing-types'
import type { HoldSource } from './hold-sound'

/** The preload bridge to the host's music control; injectable for tests. */
export interface MusicBridge {
  probe(): Promise<NowPlayingProbe>
  pause(): Promise<NowPlayingPauseResult>
  resume(playerId: string): Promise<NowPlayingResumeResult>
}

export interface UserMusicState {
  /** A player was playing when voice mode came on, and voice mode is holding it. */
  active: boolean
  /** That player's name, for the controls. */
  playerName: string | null
}

const IDLE: UserMusicState = { active: false, playerName: null }

/** How long a resume the host could not carry out waits before the hold tries it again. */
export const RESUME_RETRY_MS = 2_000

function bridgeFromWindow(): MusicBridge | null {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI
  if (!api?.musicProbe) return null
  return {
    probe: () => api.musicProbe(),
    pause: () => api.musicPause(),
    resume: (playerId) => api.musicResume(playerId),
  }
}

/**
 * The person's own music player as the hold sound. When voice mode comes on
 * while Spotify, Music or a browser is playing, the player is paused and
 * held; the hold hook then drives this like the built-in loop, with the
 * verbs reversed: start() lets the music play while the agent works, stop()
 * pauses it when someone is about to speak. Leaving voice mode gives the
 * music back.
 *
 * Pausing always asks the host what is playing first, so a player the
 * person paused themselves is never started again against their wish.
 * Commands are asynchronous and serialized; the hook's calls are
 * synchronous intents that the queue reconciles in order. Voice mode keeps
 * holding a player until the host confirms it plays again, so a resume that
 * failed is tried again rather than leaving the music paused for good.
 */
export class UserMusic implements HoldSource {
  private readonly bridge: MusicBridge | null
  private state: UserMusicState = IDLE
  private player: NowPlayingPlayer | null = null
  /** Voice mode paused it, so voice mode may start it again. */
  private pausedByUs = false
  private want: 'paused' | 'playing' = 'paused'
  private queue: Promise<void> = Promise.resolve()
  /** Bumped by begin() and end(): work from an earlier session must not touch a later one. */
  private session = 0
  /** Reconciles queued or running, so the hold's polling never stacks resumes. */
  private pending = 0
  private resumeRetryAt = 0
  private readonly listeners = new Set<() => void>()

  constructor(options: { bridge?: MusicBridge | null } = {}) {
    this.bridge = options.bridge === undefined ? bridgeFromWindow() : options.bridge
  }

  /** Whether this window can reach a music player at all. */
  get available(): boolean {
    return this.bridge !== null
  }

  getState = (): UserMusicState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Voice mode came on: take over a player that is playing, pausing it until
   * the agent works. Resolves once the host has answered; nothing was taken
   * when the state stays inactive.
   */
  async begin(): Promise<void> {
    const bridge = this.bridge
    if (!bridge) return
    const session = ++this.session
    this.want = 'paused'
    await this.enqueue(async () => {
      // Handed over by an end() that a begin() followed at once (React
      // replays a mount's effects in development): already ours, paused.
      if (this.player && this.pausedByUs) {
        if (session === this.session) this.setState({ active: true, playerName: this.player.name })
        return
      }
      const paused = await this.pause(bridge)
      if (!paused) return
      // Held even when voice mode went off meanwhile: whatever ended or
      // restarted the session queued behind this, and gives it back or keeps it.
      this.player = paused
      this.pausedByUs = true
      if (session === this.session) this.setState({ active: true, playerName: paused.name })
    })
  }

  /** Voice mode went off: give the music back if voice mode is the one holding it. */
  async end(): Promise<void> {
    const bridge = this.bridge
    if (!bridge) return
    const session = ++this.session
    this.want = 'paused'
    await this.enqueue(async () => {
      // Voice mode came straight back on: hand the paused player to that
      // session rather than playing it for a moment and pausing it again.
      // The OS reports a player's state a moment late, so that churn would
      // leave the next session looking at a player it thinks is not playing.
      if (session !== this.session) return
      const player = this.player
      const giveBack = this.pausedByUs
      this.player = null
      this.pausedByUs = false
      this.setState(IDLE)
      // A failure here is not retried by the renderer: main still records the
      // hold and gives the music back when the window closes or the app quits.
      if (player && giveBack) await this.resume(bridge, player)
    })
  }

  prime(): void {
    // Nothing to load: the player is already running.
  }

  start(): void {
    if (!this.state.active) return
    if (this.want === 'playing') {
      // Called on every poll while the hold lasts: act again only to retry a
      // resume the host could not carry out, one at a time.
      if (!this.pausedByUs || this.pending > 0 || Date.now() < this.resumeRetryAt) return
    }
    this.want = 'playing'
    void this.reconcile()
  }

  stop(): void {
    // No fade yet: the host has no per-player volume on any platform.
    this.stopImmediately()
  }

  stopImmediately(): void {
    if (!this.state.active || this.want === 'paused') return
    this.want = 'paused'
    void this.reconcile()
  }

  /** Bring the player to the wanted state, once the queue gets there. */
  private reconcile(): Promise<void> {
    const bridge = this.bridge
    if (!bridge) return Promise.resolve()
    const session = this.session
    this.pending++
    return this.enqueue(async () => {
      try {
        if (session !== this.session || !this.player) return
        if (this.want === 'playing') {
          if (!this.pausedByUs) return
          // Still held until the host answers: a failure is retried by the next poll and by end().
          const outcome = await this.resume(bridge, this.player)
          if (outcome === 'failed') this.resumeRetryAt = Date.now() + RESUME_RETRY_MS
          else this.pausedByUs = false
        } else if (!this.pausedByUs) {
          const paused = await this.pause(bridge)
          // Nothing playing means the person paused it themselves: leave it theirs.
          if (!paused) return
          // Recorded even when the session ended meanwhile: its end() is queued behind this.
          this.player = paused
          this.pausedByUs = true
          if (session === this.session && paused.name !== this.state.playerName) this.setState({ active: true, playerName: paused.name })
        }
      } finally {
        this.pending--
      }
    })
  }

  /** Pause whatever plays; the player that was playing, or null. */
  private async pause(bridge: MusicBridge): Promise<NowPlayingPlayer | null> {
    try {
      return (await bridge.pause()).paused
    } catch (err) {
      console.warn('User music could not be paused:', err)
      return null
    }
  }

  private async resume(bridge: MusicBridge, player: NowPlayingPlayer): Promise<NowPlayingResumeOutcome> {
    try {
      return (await bridge.resume(player.id)).outcome
    } catch (err) {
      console.warn('User music could not be resumed:', err)
      return 'failed'
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task)
    this.queue = next
    return next
  }

  private setState(next: UserMusicState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

export const userMusic = new UserMusic()
