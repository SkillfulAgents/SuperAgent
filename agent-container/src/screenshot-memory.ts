/**
 * Conditional screenshots — browser_screenshot skips the image when the page
 * looks exactly as it did in the last one.
 *
 * agent-browser 0.38+ compares each `screenshot --if-changed` capture with the
 * last one it returned for the same tab and capture mode, and writes no file
 * when no pixel differs. An "unchanged" answer alone is not enough for the
 * agent: the earlier image may be one it never saw (a browser sub-agent took
 * it) or one dropped by context compaction. So the server remembers the path
 * and time of the last image each tab and mode produced, and the unchanged
 * result names that file — an agent that no longer has it opens it with Read.
 *
 * Kept per tab (CDP target id) and per mode (viewport / full page), like the
 * CLI's own baseline. A plain capture does not move the CLI's baseline, so
 * plain captures are not recorded here either.
 */
import { z } from 'zod'

const ifChangedResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    changed: z.boolean(),
    path: z.string().optional(),
    pixelChangeRatio: z.number().optional(),
  }).nullable().optional(),
  error: z.string().nullable().optional(),
})

export interface IfChangedCapture {
  changed: boolean
  /** Present when `changed`: the new file. */
  path: string | null
  pixelChangeRatio: number
}

/** Parse `screenshot --if-changed --json` output. Null on anything unexpected. */
export function parseIfChangedOutput(stdout: string): IfChangedCapture | null {
  try {
    const r = ifChangedResponseSchema.safeParse(JSON.parse(stdout.trim()))
    if (!r.success || !r.data.success || !r.data.data) return null
    const d = r.data.data
    if (d.changed && !d.path) return null
    return { changed: d.changed, path: d.path ?? null, pixelChangeRatio: d.pixelChangeRatio ?? (d.changed ? 1 : 0) }
  } catch {
    return null
  }
}

/**
 * An earlier image older than this is not offered in place of a new one: the
 * screenshot janitor may have swept it, and "unchanged since half an hour ago"
 * is a weaker fact than a fresh image.
 */
export const SCREENSHOT_REUSE_MAX_AGE_MS = 30 * 60 * 1000

export interface RememberedScreenshot {
  path: string
  takenAt: number
}

const remembered = new Map<string, RememberedScreenshot>()

export function screenshotKey(tabKey: string, full: boolean): string {
  return `${tabKey}|${full ? 'full' : 'viewport'}`
}

export function rememberScreenshot(key: string, path: string, now = Date.now()): void {
  remembered.set(key, { path, takenAt: now })
}

/** The image an "unchanged" answer refers to, when it is recent enough to offer. */
export function recallScreenshot(key: string, now = Date.now()): RememberedScreenshot | null {
  const r = remembered.get(key)
  if (!r || now - r.takenAt > SCREENSHOT_REUSE_MAX_AGE_MS) return null
  return r
}

export function forgetScreenshots(): void {
  remembered.clear()
}
