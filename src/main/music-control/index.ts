import { app } from 'electron'
import path from 'path'
import type { NowPlayingPauseResult, NowPlayingProbe } from '@shared/lib/voice/now-playing-types'
import type { NowPlayingBackend } from './backend'
import { selectNowPlayingBackend } from './select-backend'

/**
 * Voice mode's window onto the music player: what is playing, pause it, play
 * it again. Stateless on purpose. The renderer owns the session (which
 * player it took over, whether it is the one holding it paused) because it
 * owns the turn-taking that decides when music belongs.
 */

let backend: NowPlayingBackend | null | undefined

/** Built by scripts/build-mediaremote-adapter.sh into build/, shipped as an extra resource. */
function mediaRemoteAdapterDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mediaremote-adapter')
    : path.join(app.getAppPath(), 'build', 'mediaremote-adapter')
}

function getBackend(): NowPlayingBackend | null {
  if (backend === undefined) backend = selectNowPlayingBackend(process.platform, mediaRemoteAdapterDir())
  return backend
}

export async function probeNowPlaying(): Promise<NowPlayingProbe> {
  const current = getBackend()
  if (!current) return { supported: false, player: null }
  try {
    return { supported: true, player: await current.probe() }
  } catch (err) {
    console.warn('[music-control] could not read now playing:', err)
    return { supported: true, player: null }
  }
}

/**
 * Pause whatever is audibly playing. Asks first, so a player the person
 * paused themselves is never mistaken for one voice mode paused and later
 * started again against their wish.
 */
export async function pauseNowPlaying(): Promise<NowPlayingPauseResult> {
  const current = getBackend()
  if (!current) return { paused: null }
  try {
    const player = await current.probe()
    if (!player) return { paused: null }
    await current.pause(player.id)
    return { paused: player }
  } catch (err) {
    console.warn('[music-control] could not pause:', err)
    return { paused: null }
  }
}

export async function resumeNowPlaying(playerId: string): Promise<void> {
  const current = getBackend()
  if (!current) return
  try {
    await current.play(playerId)
  } catch (err) {
    // The player quit while voice mode held it paused: nothing to give back.
    console.warn('[music-control] could not resume:', err)
  }
}
