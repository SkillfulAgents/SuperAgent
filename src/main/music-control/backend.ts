import { execFile } from 'child_process'
import type { NowPlayingPlayer } from '@shared/lib/voice/now-playing-types'

/** One OS integration: find what is playing, pause it, play it again. */
export interface NowPlayingBackend {
  /** The player that is audibly playing right now, or null. */
  probe(): Promise<NowPlayingPlayer | null>
  pause(playerId: string): Promise<void>
  play(playerId: string): Promise<void>
}

/** Runs a fixed argv and resolves with stdout; injectable for tests. */
export type RunCommand = (file: string, args: string[]) => Promise<string>

/** Nothing here may hang voice mode: a probe that takes longer is a probe that failed. */
export const COMMAND_TIMEOUT_MS = 4_000

export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
