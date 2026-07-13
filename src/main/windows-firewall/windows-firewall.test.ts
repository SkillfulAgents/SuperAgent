import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  // Queue of responses for consecutive execFile calls. Each entry is either
  // { stdout } (success) or { error } (rejection, e.g. non-zero exit).
  const responses: Array<{ stdout?: string; error?: Error }> = []
  const calls: Array<{ file: string; args: string[] }> = []
  const execFileMock = vi.fn((...cbArgs: unknown[]) => {
    const file = cbArgs[0] as string
    const args = cbArgs[1] as string[]
    const cb = cbArgs[cbArgs.length - 1] as (err: Error | null, out?: { stdout: string; stderr: string }) => void
    calls.push({ file, args })
    const next = responses.shift()
    if (!next) throw new Error('execFile called with no queued response')
    if (next.error) cb(next.error)
    else cb(null, { stdout: next.stdout ?? '', stderr: '' })
  })
  const captureException = vi.fn()
  const captureMessage = vi.fn()
  return { responses, calls, execFileMock, captureException, captureMessage }
})

vi.mock('child_process', () => ({ execFile: h.execFileMock }))
vi.mock('fs', () => {
  const m = { writeFileSync: vi.fn(), unlinkSync: vi.fn() }
  return { default: m, ...m }
})
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: h.captureException,
  captureMessage: h.captureMessage,
}))

import { getFirewallStatus, fixFirewallBlock, __resetFirewallStateForTests } from './index'

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

const CLEAN = JSON.stringify({ blockRules: [], hyperVInboundBlock: false })
const BLOCKED = JSON.stringify({
  blockRules: [
    { name: '{guid-1}', displayName: 'gamut.exe', profile: 'Private, Public' },
    { name: '{guid-2}', displayName: 'gamut.exe', profile: 'Private, Public' },
  ],
  hyperVInboundBlock: false,
})

function lastDetectArgs(): string {
  return h.calls[h.calls.length - 1].args.join(' ')
}

beforeEach(() => {
  __resetFirewallStateForTests()
  h.responses.length = 0
  h.calls.length = 0
  h.execFileMock.mockClear()
  h.captureException.mockClear()
  h.captureMessage.mockClear()
  delete process.env.SUPERAGENT_FAKE_FIREWALL_BLOCK
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('getFirewallStatus', () => {
  it('reports unsupported on non-Windows without running anything', async () => {
    setPlatform('darwin')
    const status = await getFirewallStatus()
    expect(status).toEqual({ supported: false, blocked: false, blockRuleNames: [], hyperVInboundBlock: false })
    expect(h.execFileMock).not.toHaveBeenCalled()
  })

  it('detects enabled inbound Block rules and reports to Sentry once', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: BLOCKED })

    const status = await getFirewallStatus()

    expect(status.blocked).toBe(true)
    expect(status.blockRuleNames).toEqual(['gamut.exe', 'gamut.exe'])
    expect(h.captureMessage).toHaveBeenCalledTimes(1)
    expect(lastDetectArgs()).toContain('Get-NetFirewallApplicationFilter')

    // Second call with refresh re-detects but does not re-report.
    h.responses.push({ stdout: BLOCKED })
    await getFirewallStatus({ refresh: true })
    expect(h.captureMessage).toHaveBeenCalledTimes(1)
  })

  it('normalizes the single-object blockRules shape PowerShell 5.1 can emit', async () => {
    setPlatform('win32')
    h.responses.push({
      stdout: JSON.stringify({
        blockRules: { name: '{guid}', displayName: 'gamut.exe', profile: 'Public' },
        hyperVInboundBlock: false,
      }),
    })

    const status = await getFirewallStatus()
    expect(status.blocked).toBe(true)
    expect(status.blockRuleNames).toEqual(['gamut.exe'])
  })

  it('treats a Hyper-V WSL inbound-block default as blocked even with no rules', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: JSON.stringify({ blockRules: [], hyperVInboundBlock: true }) })

    const status = await getFirewallStatus()
    expect(status.blocked).toBe(true)
    expect(status.hyperVInboundBlock).toBe(true)
    expect(status.blockRuleNames).toEqual([])
  })

  it('never reports blocked when the probe itself fails', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: 'not json at all' })

    const status = await getFirewallStatus()
    expect(status.blocked).toBe(false)
    expect(h.captureException).toHaveBeenCalledTimes(1)
  })

  it('caches results and refreshes on demand', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: CLEAN })

    await getFirewallStatus()
    await getFirewallStatus()
    expect(h.execFileMock).toHaveBeenCalledTimes(1)

    h.responses.push({ stdout: CLEAN })
    await getFirewallStatus({ refresh: true })
    expect(h.execFileMock).toHaveBeenCalledTimes(2)
  })
})

describe('fixFirewallBlock', () => {
  it('short-circuits when nothing is blocked', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: CLEAN }) // refresh detection

    const result = await fixFirewallBlock()
    expect(result).toEqual({ ok: true, status: expect.objectContaining({ blocked: false }) })
    expect(h.execFileMock).toHaveBeenCalledTimes(1) // detection only, no elevation
  })

  it('runs the elevated fix and confirms via re-detection', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: BLOCKED }) // pre-fix detection
    h.responses.push({ stdout: '' }) // elevated wrapper exits 0
    h.responses.push({ stdout: CLEAN }) // post-fix detection

    const result = await fixFirewallBlock()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status.blocked).toBe(false)
    // The elevation wrapper goes through Start-Process -Verb RunAs.
    expect(h.calls[1].args.join(' ')).toContain('Start-Process')
    expect(h.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('remediated'),
      expect.anything(),
    )
  })

  it('classifies a declined UAC prompt distinctly', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: BLOCKED })
    h.responses.push({ error: Object.assign(new Error('Command failed'), { code: 223 }) })

    const result = await fixFirewallBlock()
    expect(result).toEqual({ ok: false, reason: 'uac-declined' })
    expect(h.captureException).not.toHaveBeenCalled()
  })

  it('reports failure when the elevated script errors', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: BLOCKED })
    h.responses.push({ error: Object.assign(new Error('Command failed'), { code: 1 }) })

    const result = await fixFirewallBlock()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('failed')
    expect(h.captureException).toHaveBeenCalledTimes(1)
  })

  it('stays honest when the block persists after a "successful" fix', async () => {
    setPlatform('win32')
    h.responses.push({ stdout: BLOCKED }) // pre-fix
    h.responses.push({ stdout: '' }) // elevation "succeeds"
    h.responses.push({ stdout: BLOCKED }) // still blocked

    const result = await fixFirewallBlock()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('failed')
  })

  it('includes the Hyper-V remediation only when that layer was the blocker', async () => {
    setPlatform('win32')
    const fsMock = vi.mocked((await import('fs')).writeFileSync)
    h.responses.push({ stdout: JSON.stringify({ blockRules: [], hyperVInboundBlock: true }) })
    h.responses.push({ stdout: '' })
    h.responses.push({ stdout: CLEAN })

    await fixFirewallBlock()
    const script = String(fsMock.mock.calls[fsMock.mock.calls.length - 1][1])
    expect(script).toContain('Set-NetFirewallHyperVVMSetting')
  })
})

describe('fake block mode (dev/E2E)', () => {
  it('fakes a block on any platform and clears it via the fix flow', async () => {
    setPlatform('darwin')
    process.env.SUPERAGENT_FAKE_FIREWALL_BLOCK = '1'

    const status = await getFirewallStatus()
    expect(status.blocked).toBe(true)
    expect(h.execFileMock).not.toHaveBeenCalled()

    const result = await fixFirewallBlock()
    expect(result.ok).toBe(true)
    expect((await getFirewallStatus()).blocked).toBe(false)
  })
})
