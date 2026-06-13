/**
 * Regression guards for the agent-browser 0.12.0 → 0.25.3 → 0.27.2 upgrades.
 *
 * These tests prevent re-introducing issues discovered during the upgrades:
 * - --remote-debugging-port in AGENT_BROWSER_ARGS hangs the daemon on ARM64
 * - rewriteTabNewCommand workaround no longer needed
 * - playwright-core path for macEditingCommands no longer exists
 * - 0.26.0+ tabs use stable string ids (t1, t2, …); the daemon's tab_list
 *   responses carry `tabId` (no numeric `index`), and the CLI rejects
 *   bare-integer `tab <n>` with a teaching error
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const DOCKERFILE_PATH = path.resolve(__dirname, '../Dockerfile')
const dockerfile = fs.readFileSync(DOCKERFILE_PATH, 'utf-8')

describe('Dockerfile agent-browser config', () => {
  it('installs agent-browser 0.27.2 or later', () => {
    const match = dockerfile.match(/agent-browser@(\d+\.\d+\.\d+)/)
    expect(match).not.toBeNull()
    const [major, minor, patch] = match![1].split('.').map(Number)
    // Must be >= 0.27.2: stable tab ids (0.26.0), off-viewport click
    // scroll-into-view, wait --timeout handling, daemon latency/respawn fixes (0.27.2)
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(27_002)
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

describe('stable tab ids (agent-browser 0.26.0+)', () => {
  // The CLI rejects bare-integer `tab <n>` with a teaching error since 0.26.0.
  // Nothing we ship to the model may teach positional tab indices, and nothing
  // in our code may read the removed numeric `index` field off daemon tabs.

  it('tab-manager uses daemon tabId, not a numeric index', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'tab-manager.ts'), 'utf-8')
    expect(source).toContain('tabId: string')
    expect(source).not.toMatch(/\bindex: number/)
    expect(source).not.toContain('activeIndex')
  })

  it('server.ts switches tabs by stable id, not positional index', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'server.ts'), 'utf-8')
    expect(source).not.toContain('String(matchingTab.index)')
    expect(source).toContain('matchingTab.tabId')
  })

  it('model-facing text never teaches bare-integer tab switching', () => {
    const files = ['web-browser-agent-prompt.md', 'tools/browser.ts', 'tab-manager.ts']
    for (const f of files) {
      const source = fs.readFileSync(path.resolve(__dirname, f), 'utf-8')
      expect(source, `${f} teaches old tab <n> syntax`).not.toMatch(/tab <n>|tab <prev>/)
    }
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
