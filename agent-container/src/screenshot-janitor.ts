/**
 * Screenshot Janitor - Bounds the disk held by agent-browser screenshots
 *
 * Every `browser_screenshot` and `browser_get_state` call makes agent-browser
 * write a uniquely named PNG (~500KB each) that nothing ever deletes. The tool
 * result advertises the file path and agents read it back after the call, so
 * files cannot be unlinked eagerly — instead they are kept for a generous
 * window and swept once clearly abandoned.
 *
 * The output directory is pinned via AGENT_BROWSER_SCREENSHOT_DIR (honored by
 * the agent-browser CLI/daemon) so the janitor's target is deterministic
 * rather than tracking the CLI's default-path convention across versions.
 */

import fs from 'fs/promises'
import path from 'path'

/**
 * How old a screenshot must be before the janitor deletes it. Screenshots are
 * referenced by path in tool results and re-read within the same turn or
 * shortly after; a day is far beyond any legitimate reuse.
 */
export const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Pin agent-browser's screenshot output directory so every spawned
 * CLI/daemon (which inherit process.env) writes to a location the janitor
 * knows about. The default mirrors agent-browser's own convention
 * ($HOME/.agent-browser/tmp/screenshots) so files accumulated before the
 * pin existed get swept too. A pre-set env var wins.
 */
export function pinScreenshotDir(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.AGENT_BROWSER_SCREENSHOT_DIR) {
    env.AGENT_BROWSER_SCREENSHOT_DIR = path.join(
      env.HOME || '/home/claude',
      '.agent-browser',
      'tmp',
      'screenshots'
    )
  }
  return env.AGENT_BROWSER_SCREENSHOT_DIR
}

/**
 * Delete files in `dir` older than `maxAgeMs`. Age is measured by mtime —
 * birthtime is unreliable on some mounts (e.g. S3-backed NFS reports epoch 0)
 * and screenshots are written once, so mtime is creation time.
 * @returns number of files removed
 */
export async function sweepStaleScreenshots(
  dir: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = SCREENSHOT_MAX_AGE_MS
): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    // Directory doesn't exist until the first screenshot is taken
    return 0
  }

  let removed = 0
  for (const name of names) {
    const filePath = path.join(dir, name)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) continue
      if (nowMs - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(filePath)
        removed++
      }
    } catch {
      // Raced with a concurrent delete or unreadable entry — skip it
    }
  }

  if (removed > 0) {
    console.log(`[ScreenshotJanitor] Removed ${removed} stale screenshot(s) from ${dir}`)
  }
  return removed
}

/**
 * Pin the screenshot directory, sweep it once now, and keep sweeping hourly.
 * Call once at server startup, before any browser command can run.
 */
export function startScreenshotJanitor(): void {
  const dir = pinScreenshotDir()
  void sweepStaleScreenshots(dir)
  setInterval(() => {
    void sweepStaleScreenshots(dir)
  }, SWEEP_INTERVAL_MS).unref()
}
