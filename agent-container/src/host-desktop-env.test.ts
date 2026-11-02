import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppSandboxHost, isComputerUseHost } from './host-desktop-env'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isComputerUseHost', () => {
  it('takes the host’s answer, whatever its OS', () => {
    vi.stubEnv('HOST_PLATFORM', 'darwin')
    vi.stubEnv('HOST_COMPUTER_USE', 'false')
    expect(isComputerUseHost()).toBe(false)
    vi.stubEnv('HOST_COMPUTER_USE', 'true')
    expect(isComputerUseHost()).toBe(true)
  })

  it.each([
    ['darwin', true],
    ['win32', true],
    ['linux', false],
  ])('falls back to the OS for a host too old to answer: %s → %s', (platform, expected) => {
    vi.stubEnv('HOST_PLATFORM', platform)
    vi.stubEnv('HOST_COMPUTER_USE', undefined)
    expect(isComputerUseHost()).toBe(expected)
  })
})

describe('isAppSandboxHost', () => {
  it('is true only when the host says it is sandboxed', () => {
    vi.stubEnv('HOST_APP_SANDBOX', 'true')
    expect(isAppSandboxHost()).toBe(true)
    vi.stubEnv('HOST_APP_SANDBOX', undefined)
    expect(isAppSandboxHost()).toBe(false)
  })
})
