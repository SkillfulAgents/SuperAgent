import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Which files exist, for the binary lookup; the real file system unless a test says otherwise.
let exists: ((file: string) => boolean) | null = null
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: (file: string) => (exists ? exists(file) : actual.existsSync(file)) }
})

const { agentDesktopNamedCopy, commandTimeoutMs, forgetAgentDesktopBinary, resolveAgentDesktopBinary } = await import('./agent-desktop')

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
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    exists = (file) => path.basename(file) === 'agent-desktop'
    expect(resolveAgentDesktopBinary().executable).not.toBe('/lab/bin/agent-desktop')
  })

  it('finds the arch-named binary on Windows, where the package keeps no agent-desktop.exe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    exists = (file) => path.basename(file) === 'agent-desktop-win32-x64.exe'

    // Copied as agent-desktop.exe for the cursor; with no real file to copy, the package's binary runs.
    expect(path.basename(resolveAgentDesktopBinary().executable)).toMatch(/^agent-desktop(-win32-x64)?\.exe$/)
  })
})

describe('agentDesktopNamedCopy', () => {
  it('runs a copy named agent-desktop.exe, made again only when the binary changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-copy-'))
    const source = path.join(dir, 'agent-desktop-win32-x64.exe')
    fs.writeFileSync(source, 'v1')
    const bin = path.join(dir, 'bin')

    const copy = agentDesktopNamedCopy(source, bin)
    expect(copy).toBe(path.join(bin, 'agent-desktop.exe'))
    expect(fs.readFileSync(copy, 'utf8')).toBe('v1')

    fs.writeFileSync(copy, 'v1')
    fs.utimesSync(copy, fs.statSync(source).atime, fs.statSync(source).mtime)
    const untouched = fs.statSync(copy).mtimeMs
    agentDesktopNamedCopy(source, bin)
    expect(fs.statSync(copy).mtimeMs).toBe(untouched)

    fs.writeFileSync(source, 'version 2')
    agentDesktopNamedCopy(source, bin)
    expect(fs.readFileSync(copy, 'utf8')).toBe('version 2')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to the package binary when it cannot copy', () => {
    expect(agentDesktopNamedCopy(path.join(os.tmpdir(), 'no-such-agent-desktop.exe'), path.join(os.tmpdir(), 'no-copy-here')))
      .toBe(path.join(os.tmpdir(), 'no-such-agent-desktop.exe'))
  })
})

describe('commandTimeoutMs', () => {
  it('gives a wait for a duration that long, written before or after --', () => {
    expect(commandTimeoutMs(['wait', '120000'])).toBe(135_000)
    expect(commandTimeoutMs(['wait', '--', '120000'])).toBe(135_000)
    expect(commandTimeoutMs(['wait', '--text', 'Saved', '--app', 'TextEdit'])).toBe(45_000)
  })
})
