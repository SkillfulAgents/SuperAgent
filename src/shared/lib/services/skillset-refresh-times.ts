/**
 * When each skillset's cache was last refreshed. In AppState, so a host that serves its tenant
 * from many short-lived processes shares it: a process that just started sees a refresh another
 * one made, instead of downloading the skillset again.
 */
import path from 'path'
import { z } from 'zod'
import { appState, defineNamespace, digestKeyPart } from '@shared/lib/app-state'

// Background refreshes (opening an agent) reuse a cache refreshed this recently.
// Each public-skillset refresh spends one of GitHub's 60 unauthenticated API
// calls per hour, shared by everyone behind the same IP.
export const BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS = 15 * 60_000

// No caller asks about a refresh older than the background window, so an entry lives that long.
const refreshTimes = defineNamespace({
  name: 'cache:skillset-refreshed-at',
  consistency: 'eventual',
  schema: z.object({ at: z.number() }),
  expiry: { ttlMs: BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS, onUpdate: 'reset' },
})

// The cache folder's name is the repo's id, the same in every process. It can hold a URL's parts, which stay out of an AppState key.
const keyFor = (repoDir: string) => refreshTimes.key(digestKeyPart(path.basename(repoDir)))

/** Epoch ms of the cache's last refresh, or undefined when none is known. AppState failing reads as none: the skillset is refreshed. */
export async function skillsetRefreshedAt(repoDir: string): Promise<number | undefined> {
  try {
    return (await appState().get(keyFor(repoDir)))?.value.at
  } catch (error) {
    console.warn(`[skillsets] Could not read when ${repoDir} was refreshed:`, error)
    return undefined
  }
}

export async function recordSkillsetRefreshed(repoDir: string): Promise<void> {
  try {
    await appState().set(keyFor(repoDir), { at: Date.now() })
  } catch (error) {
    console.warn(`[skillsets] Could not record the refresh of ${repoDir}:`, error)
  }
}

export async function forgetSkillsetRefreshed(repoDir: string): Promise<void> {
  try {
    await appState().delete(keyFor(repoDir))
  } catch (error) {
    console.warn(`[skillsets] Could not forget the refresh of ${repoDir}:`, error)
  }
}
