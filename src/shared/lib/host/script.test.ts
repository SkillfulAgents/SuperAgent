import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExec = vi.fn()
const mockExecFile = vi.fn()
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import { runHostScript } from './script'

type Callback = (error: unknown, result?: { stdout: string; stderr: string }) => void
const succeed = (stdout: string, stderr = '') => (...args: unknown[]) => (args.at(-1) as Callback)(null, { stdout, stderr })
const fail = (error: Record<string, unknown>) => (...args: unknown[]) => (args.at(-1) as Callback)(Object.assign(new Error('failed'), error))

beforeEach(() => {
  mockExec.mockReset()
  mockExecFile.mockReset()
})

describe('runHostScript', () => {
  it('runs a shell script under zsh with a 30-second limit', async () => {
    mockExec.mockImplementation(succeed('ok\n'))
    await expect(runHostScript('echo ok', 'shell')).resolves.toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
    expect(mockExec).toHaveBeenCalledWith('echo ok', { timeout: 30_000, shell: '/bin/zsh' }, expect.any(Function))
  })

  it('runs AppleScript through osascript, one -e per non-blank line', async () => {
    mockExecFile.mockImplementation(succeed('done'))
    await runHostScript('tell application "Finder"\n\n  activate\nend tell', 'applescript')
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      ['-e', 'tell application "Finder"', '-e', '  activate', '-e', 'end tell'],
      { timeout: 30_000 },
      expect.any(Function),
    )
  })

  it('runs PowerShell through powershell.exe', async () => {
    mockExecFile.mockImplementation(succeed('6'))
    await runHostScript('$PSVersionTable.PSVersion.Major', 'powershell')
    expect(mockExecFile).toHaveBeenCalledWith(
      'powershell.exe',
      ['-Command', '$PSVersionTable.PSVersion.Major'],
      { timeout: 30_000 },
      expect.any(Function),
    )
  })

  it('reports a failing script with its exit code and output rather than throwing', async () => {
    mockExec.mockImplementation(fail({ code: 2, stdout: 'partial', stderr: 'boom' }))
    await expect(runHostScript('exit 2', 'shell')).resolves.toEqual({ exitCode: 2, stdout: 'partial', stderr: 'boom' })
  })

  it('reports an interpreter that could not start by its spawn error', async () => {
    mockExecFile.mockImplementation(fail({ code: 'ENOENT' }))
    await expect(runHostScript('x', 'powershell')).resolves.toEqual({ exitCode: 'ENOENT', stdout: '', stderr: '' })
  })

  it('reports a killed script (timeout) as exit code 1', async () => {
    mockExec.mockImplementation(fail({ code: null, killed: true, signal: 'SIGTERM' }))
    await expect(runHostScript('sleep 60', 'shell')).resolves.toEqual({ exitCode: 1, stdout: '', stderr: '' })
  })
})
