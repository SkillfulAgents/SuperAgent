import type { NowPlayingPauseResult, NowPlayingPlayer, NowPlayingProbe } from '@shared/lib/voice/now-playing-types'
import type { HoldSource } from './hold-sound'

/** The preload bridge to the host's music control; injectable for tests. */
export interface MusicBridge {
  probe(): Promise<NowPlayingProbe>
  pause(): Promise<NowPlayingPauseResult>
  resume(playerId: string): Promise<void>
}

export interface UserMusicState {
  /** A player was playing when voice mode came on, and voice mode is holding it. */
  active: boolean
  /** That player's name, for the controls. */
  playerName: string | null
}

const IDLE: UserMusicState = { active: false, playerName: null }

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
 * synchronous intents that the queue reconciles in order.
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
      let paused: NowPlayingPlayer | null
      try {
        paused = (await bridge.pause()).paused
      } catch (err) {
        console.warn('User music could not be paused:', err)
        return
      }
      if (session !== this.session || !paused) return
      this.player = paused
      this.pausedByUs = true
      this.setState({ active: true, playerName: paused.name })
    })
  }

  /** Voice mode went off: give the music back if voice mode is the one holding it. */
  async end(): Promise<void> {
    const bridge = this.bridge
    if (!bridge) return
    this.session++
    this.want = 'paused'
    await this.enqueue(async () => {
      const player = this.player
      const giveBack = this.pausedByUs
      this.player = null
      this.pausedByUs = false
      this.setState(IDLE)
      if (player && giveBack) await this.resume(bridge, player)
    })
  }

  prime(): void {
    // Nothing to load: the player is already running.
  }

  start(): void {
    if (!this.state.active || this.want === 'playing') return
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
    return this.enqueue(async () => {
      if (session !== this.session || !this.player) return
      if (this.want === 'playing') {
        if (!this.pausedByUs) return
        this.pausedByUs = false
        await this.resume(bridge, this.player)
      } else if (!this.pausedByUs) {
        let paused: NowPlayingPlayer | null
        try {
          paused = (await bridge.pause()).paused
        } catch (err) {
          console.warn('User music could not be paused:', err)
          return
        }
        if (session !== this.session) return
        // Nothing playing means the person paused it themselves: leave it theirs.
        if (!paused) return
        this.player = paused
        this.pausedByUs = true
        if (paused.name !== this.state.playerName) this.setState({ active: true, playerName: paused.name })
      }
    })
  }

  private async resume(bridge: MusicBridge, player: NowPlayingPlayer): Promise<void> {
    try {
      await bridge.resume(player.id)
    } catch (err) {
      console.warn('User music could not be resumed:', err)
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
