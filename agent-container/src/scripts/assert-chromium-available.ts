/**
 * Build-time canary: fails the Docker build if the stable Chromium symlink
 * created earlier in the Dockerfile is missing, not executable, or broken.
 *
 * Runs the same resolver the dashboard-screenshot module uses at runtime,
 * then spawns the binary with --version to confirm it actually works. A
 * future agent-browser or playwright-core upgrade that changes the on-disk
 * layout breaks this immediately rather than silently at start_dashboard
 * time.
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { resolveChromiumExecutable } from '../dashboard-screenshot'

const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/playwright-browsers'

function fail(message: string): never {
  console.error('[assert-chromium-available] FAIL:', message)
  try {
    const entries = fs.readdirSync(browsersPath)
    console.error(`  ${browsersPath} contents:`, entries)
  } catch (error) {
    console.error(`  ${browsersPath} unreadable:`, (error as Error).message)
  }
  process.exit(1)
}

const executablePath = resolveChromiumExecutable()
if (!executablePath) {
  fail(`resolveChromiumExecutable() returned null — stable symlink is missing or not executable`)
}

try {
  fs.accessSync(executablePath, fs.constants.X_OK)
} catch (error) {
  fail(`Resolved path is not executable: ${executablePath} (${(error as Error).message})`)
}

const result = spawnSync(executablePath, ['--version'], { encoding: 'utf-8', timeout: 10_000 })
if (result.status !== 0) {
  fail(
    `${path.basename(executablePath)} --version exited ${result.status ?? 'null'}: ${result.stderr || result.stdout || '(no output)'}`
  )
}

console.log(`[assert-chromium-available] OK: ${executablePath}`)
console.log(`  version: ${result.stdout.trim()}`)
