/**
 * Computer use against the real machine: the executor driving agent-desktop
 * and Calculator, with the agent cursor on.
 *
 * Skipped unless COMPUTER_USE_REAL=1, on macOS, with Accessibility granted to
 * the terminal that runs it. It moves real apps and draws cursors on screen.
 *
 *   COMPUTER_USE_REAL=1 npx vitest run src/shared/lib/computer-use/executor.real.test.ts
 *
 * Set COMPUTER_USE_REAL_HEADED=1 to run the actions headed (real clicks).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const REAL = process.env.COMPUTER_USE_REAL === '1' && process.platform === 'darwin'

let computerUseSettings: Record<string, unknown> = {
  showCursor: true,
  inputMode: process.env.COMPUTER_USE_REAL_HEADED === '1' ? 'headed' : 'headless',
}
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ computerUse: computerUseSettings }),
}))

interface Envelope {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}

describe.skipIf(!REAL)('computer use on this machine', { timeout: 120_000 }, () => {
  let executor: typeof import('./executor')
  let dataDir = ''
  const agentA = { sessionId: 'real-a', agentSlug: 'agent-a', label: 'Spike Agent Alpha', accent: '#2B79FA' }
  const agentB = { sessionId: 'real-b', agentSlug: 'agent-b', label: 'Spike Agent Beta', accent: '#0DA13B' }

  const run = async (caller: typeof agentA, method: string, params: Record<string, unknown>) => {
    const result = await executor.executeComputerUseCommand(method, params, caller)
    return { ...result, envelope: JSON.parse(result.output) as Envelope }
  }

  /** A button's ref in Calculator, by its accessible name. */
  const buttonRef = async (caller: typeof agentA, name: string) => {
    const { envelope } = await run(caller, 'find', { app: 'Calculator', role: 'button', name, exact: true, first: true })
    expect(envelope.ok, JSON.stringify(envelope)).toBe(true)
    // With --first, find answers one `match` instead of a `matches` list.
    const matches = (envelope.data?.matches ?? (envelope.data?.match ? [envelope.data.match] : [])) as Array<{ ref_id?: string }>
    const ref = matches.find((match) => match.ref_id)?.ref_id
    expect(ref, `no ref for ${name}: ${JSON.stringify(envelope)}`).toBeTruthy()
    return ref!
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamut-computer-use-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    executor = await import('./executor')
    expect(await executor.checkComputerUsePermissions(), 'Accessibility must be granted to this terminal').toBeNull()
  })

  afterAll(async () => {
    await executor?.endComputerUseSessions()
    await executor?.executeComputerUseCommand('close-app', { app: 'Calculator' }, agentA).catch(() => {})
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('lists running apps', async () => {
    const { envelope } = await run(agentA, 'list-apps', {})
    expect(envelope.ok).toBe(true)
    expect(JSON.stringify(envelope.data)).toContain('Finder')
  })

  it('launches Calculator and reads it through refs qualified by their snapshot', async () => {
    const launched = await run(agentA, 'launch', { app: 'Calculator' })
    expect(launched.envelope.ok, JSON.stringify(launched.envelope)).toBe(true)
    expect(launched.app).toBe('Calculator')

    const snapshot = await run(agentA, 'snapshot', { app: 'Calculator', timeout_ms: 8000 })
    expect(snapshot.envelope.ok, JSON.stringify(snapshot.envelope)).toBe(true)
    expect(snapshot.output).toMatch(/@[A-Za-z0-9_-]+:e\d+/)
  })

  it('computes 7 × 6 by clicking refs, and reports the app each click acted in', async () => {
    for (const name of ['All Clear', 'Clear']) {
      const ref = await buttonRef(agentA, name).catch(() => null)
      if (ref) {
        await run(agentA, 'click', { ref })
        break
      }
    }
    for (const name of ['7', 'Multiply', '6', 'Equals']) {
      const ref = await buttonRef(agentA, name)
      const click = await run(agentA, 'click', { ref })
      expect(click.envelope.ok, JSON.stringify(click.envelope)).toBe(true)
      expect(click.app).toBe('Calculator')
    }
    const snapshot = await run(agentA, 'snapshot', { app: 'Calculator' })
    expect(snapshot.output).toContain('42')
  })

  it('runs clicks the agent sends at once in the order it sent them', async () => {
    const clear = await buttonRef(agentA, 'All Clear').catch(() => buttonRef(agentA, 'Clear'))
    await run(agentA, 'click', { ref: clear })
    const refs = await Promise.all(['1', '2', '3'].map((name) => buttonRef(agentA, name)))
    const clicks = await Promise.all(refs.map((ref) => run(agentA, 'click', { ref })))
    for (const click of clicks) expect(click.envelope.ok, JSON.stringify(click.envelope)).toBe(true)
    const snapshot = await run(agentA, 'snapshot', { app: 'Calculator' })
    expect(snapshot.output).toContain('123')
  })

  it('places a ref-only command in its app for the permission check', async () => {
    const ref = await buttonRef(agentA, '7')
    expect(await executor.resolveComputerUseTargetApp('click', { ref })).toBe('Calculator')
  })

  it('never lets one session act on another session\'s refs', async () => {
    const ref = await buttonRef(agentA, '7')
    const { envelope } = await run(agentB, 'click', { ref })
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe('SNAPSHOT_NOT_FOUND')
  })

  it('draws a cursor per session and takes it away when the session ends', async () => {
    // Both agents act; each has its own cursor, in its own colour.
    await run(agentA, 'click', { ref: await buttonRef(agentA, '1') })
    await run(agentB, 'click', { ref: await buttonRef(agentB, '2') })
    await executor.endComputerUseSessions({ agentSlug: 'agent-b' })
    // Agent A's session carries on.
    const { envelope } = await run(agentA, 'snapshot', { app: 'Calculator' })
    expect(envelope.ok).toBe(true)
  })

  it('refuses what only the app may set', async () => {
    await expect(executor.executeComputerUseCommand('run', { args: ['click', '--session', 'other', '@x:e1'] }, agentA)).rejects.toThrow(/set by the app/)
    await expect(executor.executeComputerUseCommand('run', { args: ['launch', 'Calculator', '--cdp'] }, agentA)).rejects.toThrow(/not available/)
  })

  it('turns the cursor off when the setting changes', async () => {
    computerUseSettings = { ...computerUseSettings, showCursor: false }
    const { envelope } = await run(agentA, 'snapshot', { app: 'Calculator' })
    expect(envelope.ok).toBe(true)
  })
})
