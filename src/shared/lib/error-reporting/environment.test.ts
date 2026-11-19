import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../config/settings'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
}))

vi.mock('child_process', () => ({ ...childProcess, default: childProcess }))
vi.mock('../config/data-dir', () => ({ getDataDir: () => '/data/superagent' }))

import {
  collectEnvironmentData,
  collectSettingsEnvironmentData,
  probeEnvironmentData,
  probeSettingsEnvironmentData,
} from './environment'

/** Answer every spawned program from a table of `file args` to its output; anything else fails. */
function programsAnswer(outputs: Record<string, string>) {
  childProcess.execFile.mockImplementation((file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    const output = outputs[[file, ...args].join(' ')]
    // Like the real one: the callback runs later, never during the call.
    queueMicrotask(() => {
      if (output === undefined) callback(new Error(`spawn ${file} ENOENT`), '', '')
      else callback(null, output, '')
    })
  })
}

function spawnCount(): number {
  return Object.values(childProcess).reduce((count, spawn) => count + spawn.mock.calls.length, 0)
}

function containerSettings(containerRunner: string, lima?: { vmMemory?: string }): Pick<AppSettings, 'container'> {
  return {
    container: {
      containerRunner,
      agentImage: 'ghcr.io/example/agent:1',
      resourceLimits: { cpu: 2, memory: '4g' },
      runtimeSettings: lima ? { lima } : undefined,
    },
  } as Pick<AppSettings, 'container'>
}

function onPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch)
}

const SYSTEM_VERSION_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>ProductBuildVersion</key>
	<string>24F74</string>
	<key>ProductName</key>
	<string>macOS</string>
	<key>ProductUserVisibleVersion</key>
	<string>15.5</string>
	<key>ProductVersion</key>
	<string>15.5</string>
</dict>
</plist>
`

function systemVersionFileHolds(content: string | null) {
  const readFileSync = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (path !== '/System/Library/CoreServices/SystemVersion.plist') {
      return Reflect.apply(readFileSync, fs, [path, ...rest])
    }
    if (content === null) throw new Error('ENOENT')
    return content
  }) as typeof fs.readFileSync)
}

beforeEach(() => {
  vi.clearAllMocks()
  programsAnswer({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the environment fingerprint collected on the startup path', () => {
  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['linux', 'x64'],
  ] as const)('starts no program on %s %s', (platform, arch) => {
    onPlatform(platform, arch)
    systemVersionFileHolds(SYSTEM_VERSION_PLIST)

    const data = collectEnvironmentData()
    for (const runner of ['docker', 'podman', 'lima', 'wsl2']) {
      collectSettingsEnvironmentData(containerSettings(runner))
    }

    expect(spawnCount()).toBe(0)
    expect(data).toMatchObject({ os_platform: expect.any(String), node_version: process.version })
  })

  it('reads the macOS version and build that sw_vers prints, and knows an arm64 process is not under Rosetta', () => {
    onPlatform('darwin', 'arm64')
    systemVersionFileHolds(SYSTEM_VERSION_PLIST)

    expect(collectEnvironmentData()).toMatchObject({ macos_version: '15.5', macos_build: '24F74', rosetta: false })
  })

  it('leaves Rosetta to the probe for an x64 process, the only kind that can be translated', () => {
    onPlatform('darwin', 'x64')
    systemVersionFileHolds(SYSTEM_VERSION_PLIST)

    expect(collectEnvironmentData()).not.toHaveProperty('rosetta')
  })

  it('reports an unreadable macOS version as unknown instead of throwing', () => {
    onPlatform('darwin', 'arm64')
    systemVersionFileHolds(null)

    expect(collectEnvironmentData()).toMatchObject({ macos_version: 'unknown', macos_build: 'unknown' })
  })

  it('falls back to the version Electron reports when the file cannot be read', () => {
    onPlatform('darwin', 'arm64')
    systemVersionFileHolds(null)
    const electronProcess = process as { getSystemVersion?: () => string }
    electronProcess.getSystemVersion = () => '15.5.0'
    try {
      expect(collectEnvironmentData()).toMatchObject({ macos_version: '15.5.0', macos_build: 'unknown' })
    } finally {
      delete electronProcess.getSystemVersion
    }
  })

  it('has the settings a report needs without the disk or the runner being asked', () => {
    expect(collectSettingsEnvironmentData(containerSettings('lima', { vmMemory: '8GiB' }))).toEqual({
      data_dir: '/data/superagent',
      container_runner: 'lima',
      agent_image: 'ghcr.io/example/agent:1',
      resource_limits_cpu: 2,
      resource_limits_memory: '4g',
      lima_vm_memory: '8GiB',
    })
    expect(collectSettingsEnvironmentData(containerSettings('docker'))).not.toHaveProperty('lima_vm_memory')
  })
})

describe('the environment fingerprint that needs another program', () => {
  it('asks nothing on a native arm64 Mac or on Linux', async () => {
    onPlatform('darwin', 'arm64')
    expect(await probeEnvironmentData()).toEqual({})
    onPlatform('linux', 'x64')
    expect(await probeEnvironmentData()).toEqual({})

    expect(spawnCount()).toBe(0)
  })

  it('asks an x64 Mac process whether it is translated, without blocking', async () => {
    onPlatform('darwin', 'x64')
    programsAnswer({ 'sysctl -n sysctl.proc_translated': '1\n' })
    expect(await probeEnvironmentData()).toEqual({ rosetta: true })

    programsAnswer({ 'sysctl -n sysctl.proc_translated': '0\n' })
    expect(await probeEnvironmentData()).toEqual({ rosetta: false })

    // An Intel Mac has no such key: the command fails.
    programsAnswer({})
    expect(await probeEnvironmentData()).toEqual({ rosetta: false })
    expect(childProcess.execFile).toHaveBeenCalledTimes(3)
    expect(spawnCount()).toBe(3)
  })

  it('asks Windows for its full build', async () => {
    onPlatform('win32', 'x64')
    programsAnswer({ 'cmd /c ver': '\r\nMicrosoft Windows [Version 10.0.26100.2314]\r\n' })

    expect(await probeEnvironmentData()).toEqual({ windows_build: 'Microsoft Windows [Version 10.0.26100.2314]' })
  })

  it('measures the data dir in whole GiB, as df did, and asks the configured runner for its version', async () => {
    const statfs = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bsize: 4096,
      blocks: 487049810,
      bavail: 407087371,
    } as Awaited<ReturnType<typeof fs.promises.statfs>>)
    programsAnswer({ 'docker --version': 'Docker version 29.8.2, build 7fc2dff\n' })

    expect(await probeSettingsEnvironmentData(containerSettings('docker'))).toEqual({
      disk_total_gb: 1858,
      disk_free_gb: 1553,
      docker_version: 'Docker version 29.8.2, build 7fc2dff',
    })
    expect(statfs).toHaveBeenCalledWith('/data/superagent')
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
    expect(childProcess.execFile.mock.calls[0][2]).toMatchObject({ timeout: 5000 })
    expect(spawnCount()).toBe(1)
  })

  it.each([
    ['podman', 'podman --version', 'podman_version'],
    ['lima', 'limactl --version', 'limactl_version'],
    ['wsl2', 'wsl --version', 'wsl_version'],
  ])('asks %s with "%s"', async (runner, command, key) => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('ENOSYS'))
    programsAnswer({ [command]: 'version 1.2.3\n' })

    expect(await probeSettingsEnvironmentData(containerSettings(runner))).toEqual({
      disk_total_gb: 'unknown',
      disk_free_gb: 'unknown',
      [key]: 'version 1.2.3',
    })
  })

  it('prefers the limactl the packaged app ships', async () => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('ENOSYS'))
    vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)
    const packaged = process as { resourcesPath?: string }
    packaged.resourcesPath = '/Applications/App.app/Contents/Resources'
    programsAnswer({ '/Applications/App.app/Contents/Resources/lima/bin/limactl --version': 'limactl version 1.0.0' })
    try {
      expect(await probeSettingsEnvironmentData(containerSettings('lima'))).toMatchObject({
        limactl_version: 'limactl version 1.0.0',
      })
    } finally {
      delete packaged.resourcesPath
    }
  })

  it('reports a runner that is missing, or that cannot be started, as unknown', async () => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('ENOSYS'))

    expect(await probeSettingsEnvironmentData(containerSettings('docker'))).toMatchObject({ docker_version: 'unknown' })

    childProcess.execFile.mockImplementation(() => { throw new Error('EPERM') })
    expect(await probeSettingsEnvironmentData(containerSettings('docker'))).toMatchObject({ docker_version: 'unknown' })
  })
})
