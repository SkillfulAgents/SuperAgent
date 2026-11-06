import { afterEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'

// Which files exist, for the binary lookup; the real file system unless a test says otherwise.
let exists: ((file: string) => boolean) | null = null
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: (file: string) => (exists ? exists(file) : actual.existsSync(file)) }
})

const { commandTimeoutMs, forgetAgentDesktopBinary, resolveAgentDesktopBinary } = await import('./agent-desktop')

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const ORIGINAL_ARCH = Object.getOwnPropertyDescriptor(process, 'arch')!

afterEach(() => {
  exists = null
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  Object.defineProperty(process, 'arch', ORIGINAL_ARCH)
  forgetAgentDesktopBinary()
})

describe('resolveAgentDesktopBinary', () => {
  it('takes a stand-in executable only outside a packaged app', () => {
    vi.stubEnv('SUPERAGENT_AGENT_DESKTOP', '/lab/bin/agent-desktop')
    vi.stubEnv('SUPERAGENT_IS_PACKAGED', '0')
    expect(resolveAgentDesktopBinary().executable).toBe('/lab/bin/agent-desktop')

    forgetAgentDesktopBinary()
    vi.stubEnv('SUPERAGENT_IS_PACKAGED', '1')
    exists = (file) => path.basename(file) === 'agent-desktop'
    expect(resolveAgentDesktopBinary().executable).not.toBe('/lab/bin/agent-desktop')
  })

  it('finds the arch-named binary on Windows, where the package keeps no agent-desktop.exe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    exists = (file) => path.basename(file) === 'agent-desktop-win32-x64.exe'

    expect(path.basename(resolveAgentDesktopBinary().executable)).toBe('agent-desktop-win32-x64.exe')
  })
})

describe('commandTimeoutMs', () => {
  it('gives a wait for a duration that long, written before or after --', () => {
    expect(commandTimeoutMs(['wait', '120000'])).toBe(135_000)
    expect(commandTimeoutMs(['wait', '--', '120000'])).toBe(135_000)
    expect(commandTimeoutMs(['wait', '--text', 'Saved', '--app', 'TextEdit'])).toBe(45_000)
  })
})
