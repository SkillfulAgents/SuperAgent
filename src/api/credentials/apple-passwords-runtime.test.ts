import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import {
  ApplePasswordsRuntime,
  applePasswordsChromeArguments,
  type ApplePasswordsRuntimeDependencies,
} from './apple-passwords-runtime'

function runtimeDependencies(): ApplePasswordsRuntimeDependencies {
  return {
    platform: () => 'darwin',
    findExtension: () => ({
      id: 'pejdijmoenmkgeppbflobdenhhabjlaj',
      version: '3.3.0',
      path: '/mock/extension',
    }),
    pathExists: () => true,
    spawnChrome: vi.fn(() => ({}) as ChildProcess),
  }
}

describe('ApplePasswordsRuntime hardening', () => {
  it('keeps status checks side-effect-free when prerequisites are available', async () => {
    const dependencies = runtimeDependencies()
    const runtime = new ApplePasswordsRuntime(dependencies)

    await expect(runtime.state()).resolves.toEqual({ state: null, nativeReady: false })
    expect(dependencies.spawnChrome).not.toHaveBeenCalled()
  })

  it('does not allow arbitrary WebSocket origins on the loopback debugger', () => {
    const args = applePasswordsChromeArguments('/runtime/profile', 9222)

    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).not.toContain('--remote-allow-origins=*')
    expect(args.some((arg) => arg.startsWith('--remote-allow-origins='))).toBe(false)
  })
})
