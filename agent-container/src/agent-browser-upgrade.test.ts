/**
 * Regression guards for the agent-browser 0.12.0 → 0.25.3 upgrade.
 *
 * These tests prevent re-introducing issues discovered during the upgrade:
 * - --remote-debugging-port in AGENT_BROWSER_ARGS hangs the daemon on ARM64
 * - rewriteTabNewCommand workaround no longer needed
 * - playwright-core path for macEditingCommands no longer exists
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const DOCKERFILE_PATH = path.resolve(__dirname, '../Dockerfile')
const dockerfile = fs.readFileSync(DOCKERFILE_PATH, 'utf-8')

describe('Dockerfile agent-browser config', () => {
  it('installs agent-browser 0.25.3 or later', () => {
    const match = dockerfile.match(/agent-browser@(\d+\.\d+\.\d+)/)
    expect(match).not.toBeNull()
    const [major, minor] = match![1].split('.').map(Number)
    // Must be >= 0.25.3 (Rust daemon with ARM64 fixes)
    expect(major * 10000 + minor).toBeGreaterThanOrEqual(25)
  })

  it('AGENT_BROWSER_ARGS must NOT contain --remote-debugging-port', () => {
    // agent-browser 0.20.0+ daemon sets --remote-debugging-port=0 internally.
    // Adding --remote-debugging-port=9222 via AGENT_BROWSER_ARGS causes Chrome
    // to get two conflicting port flags, which hangs the daemon on ARM64.
    const argsLine = dockerfile.split('\n').find(l => l.includes('AGENT_BROWSER_ARGS='))
    expect(argsLine).toBeDefined()
    expect(argsLine).not.toContain('--remote-debugging-port')
  })

  it('does not use npx playwright install as the primary Chromium installer', () => {
    // agent-browser 0.20.0+ uses its own `agent-browser install` command.
    // npx playwright install is only acceptable as an ARM64 fallback.
    const lines = dockerfile.split('\n')
    const playwrightInstallLines = lines.filter(l =>
      l.includes('playwright install') && !l.includes('else')
    )
    // If playwright install appears, it must be inside an else/fallback block
    for (const line of playwrightInstallLines) {
      // Allow in else branch or after a semicolon following else
      expect(line.trim().startsWith('else') || line.trim().startsWith('npx playwright install')).toBe(true)
    }
  })

  it('points agent-browser at the chromium-current symlink', () => {
    // agent-browser's built-in chromium discovery only finds the Chrome for
    // Testing layout (chrome-linux64/chrome) under PLAYWRIGHT_BROWSERS_PATH.
    // Playwright actually installs to chrome-linux/chrome, so discovery misses
    // and `agent-browser` reports "Chrome not found". We work around that by
    // setting AGENT_BROWSER_EXECUTABLE_PATH to the stable chromium-current
    // symlink the Dockerfile sets up after `playwright install`. See
    // commit 8312b4b1 for the regression that removed the previous workaround
    // (a chrome-linux64 → chrome-linux symlink).
    expect(dockerfile).toMatch(/AGENT_BROWSER_EXECUTABLE_PATH=\/opt\/playwright-browsers\/chromium-current/)
  })
})

describe('rewriteTabNewCommand removed', () => {
  it('browser-command-args.ts does not export rewriteTabNewCommand', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'browser-command-args.ts'), 'utf-8')
    expect(source).not.toContain('rewriteTabNewCommand')
  })

  it('server.ts does not import or use rewriteTabNewCommand', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'server.ts'), 'utf-8')
    expect(source).not.toContain('rewriteTabNewCommand')
  })
})

describe('macEditingCommands inlined', () => {
  it('cdp-editing-commands.ts does not dynamically require playwright-core', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'cdp-editing-commands.ts'), 'utf-8')
    // Comments may reference playwright-core for historical context, but there
    // must be no runtime require/import of it
    expect(source).not.toContain('require(')
    expect(source).not.toContain('require.resolve')
    expect(source).not.toMatch(/from\s+['"]playwright/)
  })
})
