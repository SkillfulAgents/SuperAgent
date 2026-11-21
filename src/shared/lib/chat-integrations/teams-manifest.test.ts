import { describe, expect, it } from 'vitest'
import { teamsManifest } from './teams-manifest'

const appId = 'd8f87738-6378-44ac-b4d3-4c0c23ae984e'
const input = { appId, name: 'Release Assistant', version: '1.0.0' }

describe('Teams app manifest', () => {
  it('keeps the registered identity across package updates and includes only the conversation permissions required', () => {
    const previous = teamsManifest(input)
    const current = teamsManifest({ ...input, appId: appId.toUpperCase(), name: 'Build Assistant', version: '1.1.0' })
    expect(current.id).toBe(previous.id)
    expect(current.version).toBe('1.1.0')
    expect(current.manifestVersion).toBe('1.25')
    expect(current.supportsChannelFeatures).toBe('tier1')
    expect(current.bots).toEqual([{ botId: appId, scopes: ['personal', 'team', 'groupChat'], supportsFiles: true }])
    expect(current).not.toHaveProperty('authorization')
    expect(current).not.toHaveProperty('webApplicationInfo')
    expect(current.description.short).toBe('Work with Build Assistant in Microsoft Teams.')
  })

  it('fits Teams name and description limits without splitting Unicode characters', () => {
    const manifest = teamsManifest({ ...input, name: '📘'.repeat(110), description: '📕'.repeat(4100) })
    expect(manifest.name).toEqual({ short: '📘'.repeat(30), full: '📘'.repeat(100) })
    expect(manifest.description).toEqual({ short: '📕'.repeat(80), full: '📕'.repeat(4000) })
  })

  it('rejects an incomplete app ID or a version that cannot describe an upload', () => {
    expect(() => teamsManifest({ ...input, appId: 'not-an-app-id' })).toThrow()
    expect(() => teamsManifest({ ...input, version: 'latest' })).toThrow(/1\.0\.0/)
  })
})
