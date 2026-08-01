import fs from 'fs'
import path from 'path'
import { getDataDir } from '@shared/lib/config/data-dir'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { captureException, captureMessage } from '@shared/lib/error-reporting'

// Dedicated Chrome user-data-dirs for host-browser automation, one per agent
// (see chrome-provider.ts). Only `Default/` inside each dir is real per-agent
// state (cookies, logins, local storage); everything else Chrome writes there
// is a regenerable browser-level cache. Left alone, those caches grew a single
// dev machine to 10 GB — a 4 GB Gemini Nano model download per long-lived
// profile plus ~130 MB of duplicated component downloads in every profile.
// Launch flags now block the downloads (chrome-provider.ts); this module
// reclaims what already accumulated and keeps the directory bounded.
const PROFILES_DIR_NAME = 'host-browser-profiles'

// Pre-refactor single shared profile dir (singular). The rename to the plural,
// per-agent layout never removed it, stranding a stale user-data-dir.
const LEGACY_PROFILE_DIR_NAME = 'host-browser-profile'

// Browser-level (user-data-dir root) caches that are safe to delete while the
// profile's Chrome is not running: Chrome re-creates them on demand. The first
// five are component/optimization-guide downloads that the launch flags now
// prevent from re-downloading at all.
const USER_DATA_CACHE_DIRS = [
  'OptGuideOnDeviceModel',
  'optimization_guide_model_store',
  'component_crx_cache',
  'WasmTtsEngine',
  'Safe Browsing',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
]

// Regenerable caches inside the `Default/` profile. Session state (Cookies,
// Login Data, Local Storage, Service Worker, ...) must never be listed here.
const DEFAULT_PROFILE_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']

// Alert threshold for the whole profiles directory. Expected steady state is
// ~500 MB; crossing this means a new unbounded-growth vector appeared.
const PROFILES_SIZE_ALERT_BYTES = 2 * 1024 * 1024 * 1024

export function getBrowserProfilesRoot(): string {
  return path.join(getDataDir(), PROFILES_DIR_NAME)
}

/**
 * Delete an agent's dedicated Chrome user-data-dir. Called when the agent is
 * deleted, after its browser has been stopped on every provider. Refuses to
 * delete while the profile is claimed by an in-flight launch (a spawning
 * Chrome isn't registered anywhere yet, so no stop call can reach it — the
 * claim is the only signal it exists). Best-effort either way: a leftover dir
 * is reclaimed by a later startup sweep once the agent no longer exists.
 */
export async function deleteBrowserProfile(agentId: string): Promise<void> {
  if (profilesInUse.has(agentId)) {
    throw new Error(`Browser profile for "${agentId}" is claimed by a launching or running browser; skipping deletion`)
  }
  const root = getBrowserProfilesRoot()
  const profileDir = path.join(root, agentId)
  // agentId is a validated slug by the time we're called, but this deletes
  // recursively — refuse anything that escapes the profiles root, and refuse
  // the root itself (isPathWithinDir treats base === candidate as contained,
  // so an empty/'.' agentId would otherwise wipe every profile).
  if (!isPathWithinDir(root, profileDir) || path.resolve(profileDir) === path.resolve(root)) {
    throw new Error(`Refusing to delete browser profile outside profiles root: ${agentId}`)
  }
  await fs.promises.rm(profileDir, { recursive: true, force: true })
}

// Profiles currently claimed by a browser launch. ChromeProvider marks the
// profile BEFORE it awaits the in-flight sweep (and only unmarks after the
// browser is fully stopped), so the sweep and Chrome can never touch a profile
// concurrently: either the sweep sees the mark and skips the profile, or the
// launch sees the sweep's promise and waits for it. A mark leaked by a crash
// only makes the sweep skip that profile — the safe direction.
const profilesInUse = new Set<string>()

export function markProfileInUse(agentId: string): void {
  profilesInUse.add(agentId)
}

export function unmarkProfileInUse(agentId: string): void {
  profilesInUse.delete(agentId)
}

/**
 * Sweep over the host-browser profile storage:
 *  1. removes the legacy singular `host-browser-profile` dir left by a rename,
 *  2. removes profile dirs whose agent no longer exists,
 *  3. strips regenerable Chrome caches from surviving profiles (per-agent
 *     session state in `Default/` is preserved, minus its cache subdirs),
 *  4. measures what remains and reports if it exceeds the size budget, so the
 *     directory can never silently grow to GB scale again.
 *
 * Runs shortly after startup (delayed so it doesn't pile onto launch work).
 * Profiles marked in-use by a launch are skipped — they're picked up on a
 * later restart's sweep instead.
 */
export async function cleanupBrowserProfiles(agentIds: string[]): Promise<void> {
  await removeLegacyProfileDir()

  const root = getBrowserProfilesRoot()
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const known = new Set(agentIds)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (profilesInUse.has(entry.name)) continue
    const profileDir = path.join(root, entry.name)
    if (!known.has(entry.name)) {
      // Orphaned: the agent this profile belonged to no longer exists.
      console.log(`[BrowserProfiles] Removing orphaned profile ${entry.name}`)
      await fs.promises.rm(profileDir, { recursive: true, force: true })
      continue
    }
    await stripRegenerableCaches(profileDir)
  }

  await reportOversizedProfiles(root)
}

async function removeLegacyProfileDir(): Promise<void> {
  const legacyDir = path.join(getDataDir(), LEGACY_PROFILE_DIR_NAME)
  try {
    const stat = await fs.promises.stat(legacyDir)
    if (!stat.isDirectory()) return
    console.log(`[BrowserProfiles] Removing legacy profile dir ${legacyDir}`)
    await fs.promises.rm(legacyDir, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function stripRegenerableCaches(profileDir: string): Promise<void> {
  for (const name of USER_DATA_CACHE_DIRS) {
    await fs.promises.rm(path.join(profileDir, name), { recursive: true, force: true })
  }
  for (const name of DEFAULT_PROFILE_CACHE_DIRS) {
    await fs.promises.rm(path.join(profileDir, 'Default', name), { recursive: true, force: true })
  }
}

async function reportOversizedProfiles(root: string): Promise<void> {
  const totalBytes = await directorySize(root)
  const totalMb = Math.round(totalBytes / 1048576)
  console.log(`[BrowserProfiles] Profile storage after sweep: ${totalMb} MB`)
  if (totalBytes > PROFILES_SIZE_ALERT_BYTES) {
    captureMessage('Host browser profile storage exceeds size budget after cleanup sweep', {
      tags: { component: 'browser', operation: 'profile-cleanup' },
      extra: { totalMb, alertThresholdMb: Math.round(PROFILES_SIZE_ALERT_BYTES / 1048576) },
    })
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(entryPath)
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(entryPath)).size
      } catch {
        // File disappeared mid-walk; skip.
      }
    }
  }
  return total
}

// Delay before the startup sweep runs, so it doesn't pile onto the burst of
// work (container init, schedulers, image checks) happening right at launch.
const STARTUP_SWEEP_DELAY_MS = 3 * 60_000

let cleanupInFlight: Promise<void> = Promise.resolve()
let pendingSweep: NodeJS.Timeout | null = null

/**
 * Schedule the sweep to run once, shortly after startup. Never blocks or fails
 * service initialization. Browser launches await {@link waitForBrowserProfileCleanup}
 * so a launch cannot race an in-flight sweep's deletions.
 *
 * `getAgentIds` is a supplier, not a snapshot: it resolves when the timer
 * fires, so an agent created during the delay is never misclassified as an
 * orphan (which would recursively delete its cookies and session state).
 */
export function startBrowserProfileCleanup(
  getAgentIds: () => Promise<string[]> | string[],
  options: { delayMs?: number } = {},
): void {
  stopBrowserProfileCleanup()
  pendingSweep = setTimeout(() => {
    pendingSweep = null
    cleanupInFlight = Promise.resolve()
      .then(async () => cleanupBrowserProfiles(await getAgentIds()))
      .catch((error) => {
        console.error('[BrowserProfiles] Profile cleanup sweep failed:', error)
        captureException(error, { tags: { component: 'browser', operation: 'profile-cleanup' } })
      })
  }, options.delayMs ?? STARTUP_SWEEP_DELAY_MS)
  // Never hold the process open just for a pending sweep (matters for the web
  // server, whose event loop must drain on shutdown).
  pendingSweep.unref?.()
}

/** Cancel a scheduled-but-not-started sweep (shutdown). In-flight sweeps finish. */
export function stopBrowserProfileCleanup(): void {
  if (pendingSweep) {
    clearTimeout(pendingSweep)
    pendingSweep = null
  }
}

/** Resolves when no cleanup sweep is running. Never rejects. */
export function waitForBrowserProfileCleanup(): Promise<void> {
  return cleanupInFlight
}
