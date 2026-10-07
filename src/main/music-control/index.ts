import { app } from 'electron'
import path from 'path'
import type { NowPlayingPauseResult, NowPlayingPlayer, NowPlayingProbe, NowPlayingResumeResult } from '@shared/lib/voice/now-playing-types'
import type { NowPlayingBackend } from './backend'
import { selectNowPlayingBackend } from './select-backend'

/**
 * Voice mode's window onto the music player: what is playing, pause it, play
 * it again. The renderer owns the session (which player it took over,
 * whether it is the one holding it paused) because it owns the turn-taking
 * that decides when music belongs. Main only remembers which player each
 * window holds paused, so a window that closes, reloads or quits mid-session
 * still gives the music back.
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

/** The player each window (by webContents id) holds paused. */
const holds = new Map<number, string>()

/**
 * How long the OS may go on reporting a player as paused after we told it to
 * play. macOS now playing trails a command by about 200 ms; a pause asked
 * for inside this window believes our own play over the stale report.
 */
export const PLAY_SETTLE_MS = 1_500

/** The players paused so far, by id, so a play can be remembered with its name. */
const known = new Map<string, NowPlayingPlayer>()
let lastPlay: { player: NowPlayingPlayer; at: number } | null = null

function rememberPlay(playerId: string): void {
  const player = known.get(playerId)
  lastPlay = player ? { player, at: Date.now() } : null
}

/** The player we told to play a moment ago, which the OS may not report as playing yet. */
function recentlyPlayed(): NowPlayingPlayer | null {
  return lastPlay && Date.now() - lastPlay.at < PLAY_SETTLE_MS ? lastPlay.player : null
}

/**
 * Pause whatever is audibly playing on behalf of `holder`. Asks first, so a
 * player the person paused themselves is never mistaken for one voice mode
 * paused and later started again against their wish.
 */
export async function pauseNowPlaying(holder: number): Promise<NowPlayingPauseResult> {
  const current = getBackend()
  if (!current) return { paused: null }
  try {
    const player = (await current.probe()) ?? recentlyPlayed()
    if (!player) return { paused: null }
    await current.pause(player.id)
    lastPlay = null
    known.set(player.id, player)
    holds.set(holder, player.id)
    return { paused: player }
  } catch (err) {
    console.warn('[music-control] could not pause:', err)
    return { paused: null }
  }
}

/** Play again a player `holder` paused. A failure keeps the hold, so it can be tried again. */
export async function resumeNowPlaying(holder: number, playerId: string): Promise<NowPlayingResumeResult> {
  const current = getBackend()
  if (!current) {
    holds.delete(holder)
    return { outcome: 'released' }
  }
  try {
    const resumed = await current.play(playerId)
    if (resumed) rememberPlay(playerId)
    if (holds.get(holder) === playerId) holds.delete(holder)
    return { outcome: resumed ? 'resumed' : 'released' }
  } catch (err) {
    console.warn('[music-control] could not resume:', err)
    return { outcome: 'failed' }
  }
}

/** The window is gone or starting over: give back whatever it still holds. */
export async function releaseNowPlaying(holder: number): Promise<void> {
  const playerId = holds.get(holder)
  if (playerId === undefined) return
  holds.delete(holder)
  const current = getBackend()
  if (!current) return
  try {
    if (await current.play(playerId)) rememberPlay(playerId)
  } catch (err) {
    console.warn('[music-control] could not give the music back:', err)
  }
}

/** Quitting: give back every held player. */
export async function releaseAllNowPlaying(): Promise<void> {
  await Promise.all([...holds.keys()].map(releaseNowPlaying))
}

/** The lifecycle of one window that may hold a player: closed, reloaded or navigated away. */
export interface NowPlayingHolder {
  id: number
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
}

const watched = new WeakSet<NowPlayingHolder>()

/** Give the music back when `holder`'s document goes away without voice mode ending. */
export function watchNowPlayingHolder(holder: NowPlayingHolder): void {
  if (watched.has(holder)) return
  watched.add(holder)
  const id = holder.id
  holder.once('destroyed', () => { void releaseNowPlaying(id) })
  holder.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) void releaseNowPlaying(id)
  })
}
