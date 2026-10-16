/**
 * What the host knows about the music player someone was listening to when
 * voice mode came on. Shared by the main process (which asks the OS), the
 * preload bridge and the renderer (which decides when to pause and resume).
 */
export interface NowPlayingPlayer {
  /**
   * How to address the same player again: the bundle identifier on macOS,
   * the D-Bus bus name on Linux.
   */
  id: string
  /** What to call it in the UI: "Spotify", "Music", "Chrome". */
  name: string
}

export interface NowPlayingProbe {
  /** False where the host has no way to ask the OS (Windows for now). */
  supported: boolean
  /** The player that is audibly playing right now, or null when nothing is. */
  player: NowPlayingPlayer | null
}

export interface NowPlayingPauseResult {
  /** The player that was playing and is now paused, or null when nothing was playing. */
  paused: NowPlayingPlayer | null
}

/**
 * What became of a request to play a held player again:
 * - `resumed`: it is playing (or already was).
 * - `released`: it no longer holds now playing (it quit, or the person moved
 *   on to another app), so playing would start someone else's media; voice
 *   mode lets go of it.
 * - `failed`: the host could not answer; voice mode still holds it and may try again.
 */
export type NowPlayingResumeOutcome = 'resumed' | 'released' | 'failed'

export interface NowPlayingResumeResult {
  outcome: NowPlayingResumeOutcome
}
