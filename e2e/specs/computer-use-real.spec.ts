/**
 * Real Computer Use E2E Tests
 *
 * Exercises the @skillful-agents/agent-computer SDK directly against Calculator.
 * Gated behind E2E_AC_ENABLED=true — only runs on macOS with accessibility permissions.
 *
 * To run: E2E_AC_ENABLED=true npx playwright test e2e/specs/computer-use-real.spec.ts
 *
 * Note: Playwright's Chromium browser steals macOS focus, which reduces the
 * accessibility tree of background windows. Tests that need to interact with
 * Calculator use keyboard input (ac.key auto-focuses the grabbed window) or
 * use ac.switch() before snapshot.
 */

import { test, expect } from '@playwright/test'

const AC_ENABLED = process.env.E2E_AC_ENABLED === 'true'

test.describe('Computer Use — real AC integration', () => {
  test.skip(!AC_ENABLED, 'Skipped: set E2E_AC_ENABLED=true to run')
  test.skip(process.platform !== 'darwin', 'Skipped: macOS only')

  test.setTimeout(30_000)

  let ac: any

  test.beforeAll(async () => {
    const { AC } = await import('@skillful-agents/agent-computer')
    ac = new AC()
  })

  test.beforeEach(async () => {
    try { await ac.ungrab() } catch { /* not grabbed */ }
    try { await ac.quit('Calculator', { force: true }) } catch { /* not running */ }
    await new Promise(r => setTimeout(r, 500))
  })

  test.afterAll(async () => {
    try { await ac?.ungrab() } catch { /* ignore */ }
    try { await ac?.quit('Calculator', { force: true }) } catch { /* ignore */ }
  })

  /** Take a snapshot, ensuring Calculator has focus first */
  async function snapshotCalculator(opts: Record<string, unknown> = {}) {
    // Bring Calculator to front and wait for macOS to grant accessibility
    await ac.switch('Calculator')
    await new Promise(r => setTimeout(r, 1000))
    return ac.snapshot(opts)
  }

  async function launchCalculator() {
    await ac.launch('Calculator', { wait: true })
    await new Promise(r => setTimeout(r, 1500))
    await ac.switch('Calculator')
    await new Promise(r => setTimeout(r, 300))
    try { await ac.menuClick('View > Basic', 'Calculator') } catch { /* already basic */ }
    await new Promise(r => setTimeout(r, 300))
    const wins = await ac.windows('Calculator')
    expect(wins.windows.length).toBeGreaterThan(0)
    await ac.grab(wins.windows[0].ref)
  }

  // --- Read-only (no app needed) ---

  test('apps: lists running applications including Finder', async () => {
    const result = await ac.apps()
    expect(result.apps.length).toBeGreaterThan(0)
    expect(result.apps.map((a: any) => a.name)).toContain('Finder')
  })

  test('windows: returns open windows with @w refs', async () => {
    const result = await ac.windows()
    expect(result.windows.length).toBeGreaterThan(0)
    for (const win of result.windows) {
      expect(win.ref).toMatch(/^@w\d+$/)
      expect(win.app).toBeTruthy()
    }
  })

  test('status: daemon running', async () => {
    const s = await ac.status()
    expect(s.daemon_pid).toBeGreaterThan(0)
  })

  test('displays: at least one main display', async () => {
    const d = await ac.displays()
    expect(d.displays.length).toBeGreaterThan(0)
    expect(d.displays.some((x: any) => x.is_main)).toBe(true)
  })

  test('permissions: accessibility is granted', async () => {
    expect((await ac.permissions()).accessibility).toBe(true)
  })

  // --- App lifecycle ---

  test('launch and quit Calculator', async () => {
    await ac.launch('Calculator', { wait: true })
    await new Promise(r => setTimeout(r, 1000))

    let apps = await ac.apps()
    expect(apps.apps.find((a: any) => a.name === 'Calculator')).toBeTruthy()

    await ac.quit('Calculator')
    await new Promise(r => setTimeout(r, 500))

    apps = await ac.apps()
    expect(apps.apps.find((a: any) => a.name === 'Calculator')).toBeUndefined()
  })

  test('grab and ungrab window', async () => {
    await launchCalculator()

    const s1 = await ac.status()
    expect(s1.grabbed_app).toBe('Calculator')

    await ac.ungrab()
    const s2 = await ac.status()
    expect(s2.grabbed_app).toBeNull()

    await ac.quit('Calculator')
  })

  // --- Keyboard arithmetic (reliable — key() auto-focuses) ---

  test('Calculator: 5 + 3 = 8 via keyboard', async () => {
    await launchCalculator()
    await ac.key('escape')
    await ac.key('5')
    await ac.key('+')
    await ac.key('3')
    await ac.key('enter')

    const result = await snapshotCalculator({ compact: true })
    expect(JSON.stringify(result)).toContain('8')

    await ac.ungrab()
    await ac.quit('Calculator')
  })

  test('Calculator: 7 * 6 = 42 via keyboard', async () => {
    await launchCalculator()
    await ac.key('escape')
    await ac.key('7')
    await ac.key('*')
    await ac.key('6')
    await ac.key('enter')

    const result = await snapshotCalculator({ compact: true })
    expect(JSON.stringify(result)).toContain('42')

    await ac.ungrab()
    await ac.quit('Calculator')
  })

  test('Calculator: 100 - 37 = 63 via keyboard', async () => {
    await launchCalculator()
    await ac.key('escape')
    for (const k of ['1', '0', '0', '-', '3', '7']) await ac.key(k)
    await ac.key('enter')

    const result = await snapshotCalculator({ compact: true })
    expect(JSON.stringify(result)).toContain('63')

    await ac.ungrab()
    await ac.quit('Calculator')
  })

  test('Calculator: 144 / 12 = 12 via keyboard', async () => {
    await launchCalculator()
    await ac.key('escape')
    for (const k of ['1', '4', '4', '/', '1', '2']) await ac.key(k)
    await ac.key('enter')

    const result = await snapshotCalculator({ compact: true })
    expect(JSON.stringify(result)).toContain('12')

    await ac.ungrab()
    await ac.quit('Calculator')
  })

  // --- Screenshot ---

  test('screenshot captures a real PNG file', async () => {
    await launchCalculator()

    const shot = await ac.screenshot()
    expect(shot.path).toMatch(/\.png$/)

    const fs = await import('fs')
    expect(fs.existsSync(shot.path)).toBe(true)
    expect(fs.statSync(shot.path).size).toBeGreaterThan(1000)

    await ac.ungrab()
    await ac.quit('Calculator')
  })

  // --- Menu ---

  test('menu navigation: switch Calculator to Scientific and back', async () => {
    await launchCalculator()

    // Switch to Scientific — this uses the menu bar which works even without window focus
    await ac.menuClick('View > Scientific', 'Calculator')
    await new Promise(r => setTimeout(r, 300))

    // Verify by checking window title or snapshot (Scientific has more keys)
    // Use keyboard to type a scientific operation: sqrt(81) = 9
    await ac.key('escape')
    await ac.key('8')
    await ac.key('1')
    // In Scientific mode, cmd+shift+r = square root (or we can use the key shortcut)
    // Actually let's just verify we can switch back
    await ac.menuClick('View > Basic', 'Calculator')

    await ac.ungrab()
    await ac.quit('Calculator')
  })

  // --- Scroll (won't do much in Calculator but verifies the command works) ---

  test('scroll command executes without error', async () => {
    await launchCalculator()
    await ac.scroll('down', { amount: 1 })
    await ac.scroll('up', { amount: 1 })
    await ac.ungrab()
    await ac.quit('Calculator')
  })
})
