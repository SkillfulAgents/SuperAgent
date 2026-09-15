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
