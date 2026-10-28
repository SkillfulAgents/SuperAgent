import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CONFIG = '../../electron-builder.mas.cjs'

interface Resource { to: string }
interface MasConfig {
  appId: string
  protocols: { schemes: string[] }[]
  mac: {
    extraResources: Resource[]
    files: string[]
    extendInfo: Record<string, unknown>
    bundleShortVersion: string
    bundleVersion: string
    notarize: boolean
  }
  mas: { entitlements: string; entitlementsInherit: string; provisioningProfile?: string }
}

/** The Store config as electron-builder reads it, under the given environment. */
function loadConfig(env: Record<string, string | undefined> = {}): MasConfig {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  delete require.cache[require.resolve(CONFIG)]
  return require(CONFIG) as MasConfig
}

const regular = require('../../package.json') as { version: string; build: { appId: string; mac: { extraResources: Resource[]; extendInfo: Record<string, unknown> } } }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the Mac App Store build config', () => {
  it('ships what the regular build does, minus the private-framework music adapter and Spotlight', () => {
    const shipped = loadConfig().mac.extraResources.map((resource) => resource.to)
    expect(shipped).not.toContain('mediaremote-adapter')
    expect(shipped).not.toContain('spotlight-bridge')
    expect(shipped).toEqual(
      regular.build.mac.extraResources.map((resource) => resource.to).filter((to) => to !== 'mediaremote-adapter' && to !== 'spotlight-bridge'),
    )
  })

  it('leaves out computer use’s native binary', () => {
    expect(loadConfig().mac.files).toContain('!node_modules/@skillful-agents/agent-computer/bin/ac-core-darwin-*')
  })

  it('names no other product as the app, and declares the deep-link scheme it can’t register at runtime', () => {
    const config = loadConfig()
    expect(regular.build.mac.extendInfo).toHaveProperty('CFBundleAlternateNames')
    expect(config.mac.extendInfo).not.toHaveProperty('CFBundleAlternateNames')
    expect(config.protocols.flatMap((protocol) => protocol.schemes)).toEqual(['superagent'])
    expect(config.mac.extendInfo.ElectronTeamID).toBe('HL9SP7TJ3J')
  })

  it('answers export compliance, so TestFlight distributes each build without waiting for it', () => {
    expect(loadConfig().mac.extendInfo.ITSAppUsesNonExemptEncryption).toBe(false)
    expect(regular.build.mac.extendInfo).not.toHaveProperty('ITSAppUsesNonExemptEncryption')
  })

  it('gives the Store a plain version and a build number from CI, whatever the prerelease', () => {
    const version = regular.version.split(/[-+]/)[0]
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(loadConfig().mac).toMatchObject({ bundleShortVersion: version, bundleVersion: version })
    expect(loadConfig({ MAS_BUILD_NUMBER: '412' }).mac.bundleVersion).toBe('412')
    expect(loadConfig({ MAS_BUILD_NUMBER: '412.2' }).mac.bundleVersion).toBe('412.2')
  })

  it('refuses a build number the Store would reject at upload', () => {
    for (const number of ['412.', '412.1.2.3', 'v412', '412-rc.1']) {
      expect(() => loadConfig({ MAS_BUILD_NUMBER: number }), number).toThrow(/MAS_BUILD_NUMBER/)
    }
  })

  it('signs with the sandbox entitlements and a profile only from the environment', () => {
    expect(loadConfig().mas).toMatchObject({
      entitlements: 'build/entitlements.mas.plist',
      entitlementsInherit: 'build/entitlements.mas.inherit.plist',
      provisioningProfile: undefined,
    })
    expect(loadConfig({ MAS_PROVISIONING_PROFILE: '/tmp/x.provisionprofile' }).mas.provisioningProfile).toBe('/tmp/x.provisionprofile')
  })

  it('keeps the regular build as it is', () => {
    expect(regular.build.appId).toBe('com.superagent.app')
    expect(loadConfig().appId).toBe('so.gamut.app')
  })
})
