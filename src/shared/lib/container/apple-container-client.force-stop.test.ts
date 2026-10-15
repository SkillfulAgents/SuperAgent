import { describe, it, expect, vi } from 'vitest'

// Fake `container` CLI: stop and kill hang, force-delete fails, rm succeeds.
const commands: string[] = []
vi.mock('child_process', () => ({
  exec: (
    command: string,
    optionsOrCb: unknown,
    maybeCb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb)!
    commands.push(command)
    if (/ (stop|kill) /.test(command)) return {}
    if (command.includes('delete --force')) {
      cb(Object.assign(new Error('XPC connection error'), { stderr: 'XPC connection error' }))
      return {}
    }
    cb(null, { stdout: '', stderr: '' })
    return {}
  },
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ container: { containerRunner: 'apple-container' } })),
}))

import { AppleContainerClient } from './apple-container-client'

describe('AppleContainerClient.stop when the CLI is hung', () => {
  it('force-deletes only its own container and does not report a shared runtime kill', async () => {
    const client = new AppleContainerClient({ agentId: 'agent-one' })
    vi.spyOn(client as any, 'collectStopFailureDiagnostics').mockResolvedValue({})

    const result = await client.stop({ stopTimeoutMs: 10, killTimeoutMs: 10 })

    expect(result).toEqual({ forceStopUsed: false, stopped: true })
    const order = commands.map((c) => c.split(' ')[1])
    expect(order).toEqual(['stop', 'kill', 'delete', 'rm'])
    expect(commands[2]).toBe('container delete --force superagent-agent-one')
  })
})
