import { beforeEach, describe, expect, it, vi } from 'vitest'

const command = vi.fn<(cmd: string) => Promise<{ stdout: string; stderr: string }>>()
vi.mock('child_process', () => ({
  exec: (cmd: string, _options: unknown, callback: (error: unknown, result?: { stdout: string; stderr: string }) => void) => {
    command(cmd).then((result) => callback(null, result), (error: unknown) => callback(error))
  },
  execSync: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({}) }))

import { BaseContainerClient } from './base-container-client'

class Client extends BaseContainerClient {
  protected getRunnerCommand() { return 'docker' }
}
const client = () => new Client({ agentId: 'test' })

beforeEach(() => { command.mockReset() })

describe('positive container exit evidence', () => {
  it.each([
    ['running', true, false], ['paused', true, false], ['restarting', false, false],
    ['exited', false, true], ['dead', false, true], ['created', false, true],
    ['unknown', false, false],
  ])('classifies inspect state %s', async (Status, Running, stopped) => {
    command.mockResolvedValue({ stdout: JSON.stringify([{ State: { Status, Running } }]), stderr: '' })
    expect(await client().isDefinitelyStopped()).toBe(stopped)
  })

  it('keeps a stopped routing status ambiguous when the runtime is unavailable', async () => {
    command.mockRejectedValue(new Error('daemon unavailable'))
    const c = client()
    expect(await c.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
    expect(await c.isDefinitelyStopped()).toBe(false)
  })

  it.each([['other\n', true], ['superagent-test\n', false]])('requires successful evidence of absence after an inspect error', async (stdout, stopped) => {
    command.mockRejectedValueOnce(new Error('inspect failed')).mockResolvedValueOnce({ stdout, stderr: '' })
    expect(await client().isDefinitelyStopped()).toBe(stopped)
    expect(command).toHaveBeenLastCalledWith("docker ps -a --format '{{.Names}}'")
  })
})
