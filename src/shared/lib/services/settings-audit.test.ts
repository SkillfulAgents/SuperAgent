import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/lib/config/settings'
import { buildSettingsAuditDetails } from './settings-audit'

const baseSettings = (): AppSettings => ({
  container: {
    containerRunner: 'lima',
    agentImage: 'superagent:latest',
    resourceLimits: { memoryMb: 2048, cpus: 2 },
  },
  llmProvider: 'anthropic',
  models: { summarizerModel: 'haiku', agentModel: 'opus', browserModel: 'sonnet', dashboardBuilderModel: 'sonnet' },
  app: { showMenuBarIcon: true, theme: 'system' },
} as unknown as AppSettings)

describe('buildSettingsAuditDetails', () => {
  it('returns undefined when nothing changed', () => {
    expect(buildSettingsAuditDetails(baseSettings(), baseSettings())).toBeUndefined()
  })

  it('records from/to for plain value changes with the owning section', () => {
    const updated = baseSettings()
    updated.llmProvider = 'openrouter' as AppSettings['llmProvider']
    updated.container.containerRunner = 'docker'

    const details = buildSettingsAuditDetails(baseSettings(), updated)

    expect(details?.sections).toEqual(['LLM Provider', 'Runtime'])
    expect(details?.changes['llmProvider']).toEqual({ from: 'anthropic', to: 'openrouter' })
    expect(details?.changes['container.containerRunner']).toEqual({ from: 'lima', to: 'docker' })
  })

  it('never logs API key values — only set/updated/removed', () => {
    const current = baseSettings()
    current.apiKeys = { anthropicApiKey: 'sk-ant-old-secret', openrouterApiKey: 'sk-or-secret' }
    const updated = baseSettings()
    updated.apiKeys = { anthropicApiKey: 'sk-ant-new-secret', exaApiKey: 'exa-secret' }

    const details = buildSettingsAuditDetails(current, updated)

    expect(details?.changes['apiKeys.anthropicApiKey']).toBe('updated')
    expect(details?.changes['apiKeys.openrouterApiKey']).toBe('removed')
    expect(details?.changes['apiKeys.exaApiKey']).toBe('set')
    expect(JSON.stringify(details)).not.toContain('secret')
    expect(details?.sections).toEqual(['LLM Provider', 'Web'])
  })

  it('redacts custom env var values but keeps their names', () => {
    const current = baseSettings()
    current.customEnvVars = { MY_TOKEN: 'hunter2' }
    const updated = baseSettings()
    updated.customEnvVars = { MY_TOKEN: 'hunter3', EXTRA_VAR: 'v' }

    const details = buildSettingsAuditDetails(current, updated)

    expect(details?.changes['customEnvVars.MY_TOKEN']).toBe('updated')
    expect(details?.changes['customEnvVars.EXTRA_VAR']).toBe('set')
    expect(JSON.stringify(details)).not.toContain('hunter')
    expect(details?.sections).toEqual(['Runtime'])
  })

  it('redacts the favicon blob and ignores its server-stamped timestamp', () => {
    const current = baseSettings()
    const updated = baseSettings()
    updated.app = {
      ...updated.app,
      faviconDataUrl: 'data:image/png;base64,AAAA',
      faviconUpdatedAt: '2026-07-15T00:00:00.000Z',
    }

    const details = buildSettingsAuditDetails(current, updated)

    expect(details?.changes['app.faviconDataUrl']).toBe('set')
    expect(details?.changes['app.faviconUpdatedAt']).toBeUndefined()
    expect(JSON.stringify(details)).not.toContain('base64')
  })

  it('logs arrays as truncated JSON and maps nested paths to their tabs', () => {
    const current = baseSettings()
    current.webAllowedSites = ['a.com']
    current.auth = { signupMode: 'closed' }
    const updated = baseSettings()
    updated.webAllowedSites = ['a.com', 'b.com']
    updated.auth = { signupMode: 'open' }
    updated.app = { ...updated.app, notifications: { enabled: false } as never }

    const details = buildSettingsAuditDetails(current, updated)

    expect(details?.changes['webAllowedSites']).toEqual({ from: '["a.com"]', to: '["a.com","b.com"]' })
    expect(details?.changes['auth.signupMode']).toEqual({ from: 'closed', to: 'open' })
    expect(details?.sections).toEqual(['Auth', 'Notifications', 'Web'])
  })

  it('caps oversized values instead of writing them whole', () => {
    const current = baseSettings()
    const updated = baseSettings()
    updated.webBlockedSites = Array.from({ length: 100 }, (_, i) => `blocked-site-${i}.example.com`)

    const details = buildSettingsAuditDetails(current, updated)
    const change = details?.changes['webBlockedSites'] as { from: unknown; to: string }

    expect(change.from).toBeNull()
    expect(change.to.length).toBeLessThanOrEqual(201)
    expect(change.to.endsWith('…')).toBe(true)
  })

  it('ignores keys the PUT handler cannot change', () => {
    const current = baseSettings()
    const updated = baseSettings()
    updated.skillsets = [{ id: 'x' }] as never
    updated.platformAuth = { token: 't' } as never

    expect(buildSettingsAuditDetails(current, updated)).toBeUndefined()
  })
})
