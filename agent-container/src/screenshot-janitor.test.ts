import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  pinScreenshotDir,
  sweepStaleScreenshots,
  SCREENSHOT_MAX_AGE_MS,
} from './screenshot-janitor'

describe('pinScreenshotDir', () => {
  it('sets the default under HOME when unset', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/claude' }
    const dir = pinScreenshotDir(env)
    expect(dir).toBe('/home/claude/.agent-browser/tmp/screenshots')
    expect(env.AGENT_BROWSER_SCREENSHOT_DIR).toBe(dir)
  })

  it('respects a pre-set AGENT_BROWSER_SCREENSHOT_DIR', () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/home/claude',
      AGENT_BROWSER_SCREENSHOT_DIR: '/custom/shots',
    }
    expect(pinScreenshotDir(env)).toBe('/custom/shots')
    expect(env.AGENT_BROWSER_SCREENSHOT_DIR).toBe('/custom/shots')
  })

  it('falls back to /home/claude when HOME is unset', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(pinScreenshotDir(env)).toBe(
      '/home/claude/.agent-browser/tmp/screenshots'
    )
  })
})

describe('sweepStaleScreenshots', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-janitor-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeFileAgedMs(name: string, ageMs: number, now: number) {
    const filePath = path.join(dir, name)
    await fs.writeFile(filePath, 'png-bytes')
    const mtime = new Date(now - ageMs)
    await fs.utimes(filePath, mtime, mtime)
    return filePath
  }

  it('deletes files older than the max age and keeps fresh ones', async () => {
    const now = Date.now()
    const old = await writeFileAgedMs('screenshot-old.png', SCREENSHOT_MAX_AGE_MS + 60_000, now)
    const fresh = await writeFileAgedMs('screenshot-fresh.png', 60_000, now)

    const removed = await sweepStaleScreenshots(dir, now)

    expect(removed).toBe(1)
    await expect(fs.stat(old)).rejects.toThrow()
    await expect(fs.stat(fresh)).resolves.toBeDefined()
  })

  it('keeps a file just under the max age', async () => {
    const now = Date.now()
    const nearBoundary = await writeFileAgedMs('screenshot-boundary.png', SCREENSHOT_MAX_AGE_MS - 1000, now)

    expect(await sweepStaleScreenshots(dir, now)).toBe(0)
    await expect(fs.stat(nearBoundary)).resolves.toBeDefined()
  })

  it('never touches subdirectories', async () => {
    const now = Date.now()
    const subdir = path.join(dir, 'nested')
    await fs.mkdir(subdir)
    const oldMtime = new Date(now - SCREENSHOT_MAX_AGE_MS - 60_000)
    await fs.utimes(subdir, oldMtime, oldMtime)

    expect(await sweepStaleScreenshots(dir, now)).toBe(0)
    await expect(fs.stat(subdir)).resolves.toBeDefined()
  })

  it('returns 0 when the directory does not exist yet', async () => {
    const missing = path.join(dir, 'does-not-exist')
    expect(await sweepStaleScreenshots(missing, Date.now())).toBe(0)
  })

  it('honors a custom max age', async () => {
    const now = Date.now()
    await writeFileAgedMs('screenshot-hourish.png', 2 * 60 * 60 * 1000, now)

    expect(await sweepStaleScreenshots(dir, now, 60 * 60 * 1000)).toBe(1)
    expect(await fs.readdir(dir)).toEqual([])
  })
})
