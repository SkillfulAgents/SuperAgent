import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies before importing the module under test
vi.mock('fs')
vi.mock('./data-dir', () => ({
  getDataDir: vi.fn(() => '/mock/data/dir'),
}))
vi.mock('./version', () => ({
  AGENT_IMAGE_REGISTRY: 'ghcr.io/skillfulagents/superagent-agent-container-base',
  getDefaultAgentImage: vi.fn(
    () => 'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
  ),
}))

import fs from 'fs'
import {
  loadSettings,
  saveSettings,
  getSettings,
  updateSettings,
  clearSettingsCache,
  getAnthropicApiKeyStatus,
  getEffectiveAnthropicApiKey,
  getComposioApiKeyStatus,
  getEffectiveComposioApiKey,
  getComposioUserId,
  getEffectiveModels,
  getEffectiveAgentLimits,
  getCustomEnvVars,
  DEFAULT_SETTINGS,
  DEFAULT_AUTH_SETTINGS,
} from './settings'
import type { AppSettings } from './settings'

// ============================================================================
// Helpers
// ============================================================================

const mockedFs = vi.mocked(fs)

/**
 * Configure the fs mock to simulate a settings file with the given content.
 */
function mockSettingsFile(content: string) {
  mockedFs.existsSync.mockReturnValue(true)
  mockedFs.readFileSync.mockReturnValue(content)
}

/**
 * Configure the fs mock to simulate no settings file.
 */
function mockNoSettingsFile() {
  mockedFs.existsSync.mockReturnValue(false)
}

/**
 * Return a minimal complete settings object for testing saves.
 */
function makeFullSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    container: {
      containerRunner: 'docker',
      agentImage: 'ghcr.io/skillfulagents/superagent-agent-container-base:latest',
      resourceLimits: { cpu: 2, memory: '4g' },
    },
    ...overrides,
  }
}

// ============================================================================
// Setup & Teardown
// ============================================================================

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  clearSettingsCache()
  // Reset env vars that could interfere
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.COMPOSIO_API_KEY
  delete process.env.COMPOSIO_USER_ID
})

afterEach(() => {
  process.env = { ...originalEnv }
})

// ============================================================================
// loadSettings()
// ============================================================================

describe('loadSettings', () => {
  // --------------------------------------------------------------------------
  // Missing / empty / invalid file
  // --------------------------------------------------------------------------

  describe('when settings file does not exist', () => {
    it('returns default settings', () => {
      mockNoSettingsFile()

      const result = loadSettings()

      expect(result).toEqual(DEFAULT_SETTINGS)
    })

    it('returns a shallow copy, not the same reference', () => {
      mockNoSettingsFile()

      const a = loadSettings()
      const b = loadSettings()

      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })
  })

  describe('when settings file is empty', () => {
    it('returns default settings on empty string (invalid JSON)', () => {
      mockSettingsFile('')

      const result = loadSettings()

      expect(result).toEqual(DEFAULT_SETTINGS)
    })
  })

  describe('when settings file contains invalid JSON', () => {
    it('returns default settings', () => {
      mockSettingsFile('{not valid json!!!')

      const result = loadSettings()

      expect(result).toEqual(DEFAULT_SETTINGS)
    })

    it('logs an error', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSettingsFile('totally broken')

      loadSettings()

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to load settings, using defaults:',
        expect.any(SyntaxError)
      )
      consoleSpy.mockRestore()
    })
  })

  // --------------------------------------------------------------------------
  // Deep merge with defaults
  // --------------------------------------------------------------------------

  describe('deep merge with defaults', () => {
    it('merges partial container settings with defaults', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: 'podman' },
        })
      )

      const result = loadSettings()

      expect(result.container.containerRunner).toBe('podman')
      // Default agentImage should be applied (via getDefaultAgentImage mock)
      expect(result.container.agentImage).toBe(
        'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
      )
      expect(result.container.resourceLimits).toEqual({ cpu: 2, memory: '4g' })
    })

    it('merges partial resourceLimits with defaults', () => {
      mockSettingsFile(
        JSON.stringify({
          container: {
            containerRunner: 'docker',
            resourceLimits: { cpu: 8 },
          },
        })
      )

      const result = loadSettings()

      expect(result.container.resourceLimits.cpu).toBe(8)
      expect(result.container.resourceLimits.memory).toBe('4g') // default
    })

    it('merges partial notification settings with defaults', () => {
      mockSettingsFile(
        JSON.stringify({
          app: {
            notifications: { sessionComplete: false },
          },
        })
      )

      const result = loadSettings()

      expect(result.app?.notifications?.sessionComplete).toBe(false)
      expect(result.app?.notifications?.enabled).toBe(true) // default
      expect(result.app?.notifications?.sessionWaiting).toBe(true) // default
      expect(result.app?.notifications?.sessionScheduled).toBe(true) // default
    })

    it('merges partial app preferences with defaults', () => {
      mockSettingsFile(
        JSON.stringify({
          app: { showMenuBarIcon: false },
        })
      )

      const result = loadSettings()

      expect(result.app?.showMenuBarIcon).toBe(false)
      expect(result.app?.autoSleepTimeoutMinutes).toBe(30) // default
      // notifications still get defaults
      expect(result.app?.notifications?.enabled).toBe(true)
    })

    it('merges partial model settings with defaults', () => {
      mockSettingsFile(
        JSON.stringify({
          models: { agentModel: 'claude-sonnet-4-6' },
        })
      )

      const result = loadSettings()

      expect(result.models?.agentModel).toBe('claude-sonnet-4-6')
      expect(result.models?.summarizerModel).toBe('claude-haiku-4-5') // default
      expect(result.models?.browserModel).toBe('claude-sonnet-4-6') // default
    })

    it('merges auth settings with defaults', () => {
      mockSettingsFile(
        JSON.stringify({
          auth: { signupMode: 'open', passwordMinLength: 8 },
        })
      )

      const result = loadSettings()

      expect(result.auth?.signupMode).toBe('open')
      expect(result.auth?.passwordMinLength).toBe(8)
      // Remaining defaults should be preserved
      expect(result.auth?.requireAdminApproval).toBe(true)
      expect(result.auth?.allowLocalAuth).toBe(true)
      expect(result.auth?.allowSocialAuth).toBe(false)
      expect(result.auth?.passwordMaxLength).toBe(128)
      expect(result.auth?.passwordRequireComplexity).toBe(true)
      expect(result.auth?.sessionMaxLifetimeHrs).toBe(24)
      expect(result.auth?.sessionIdleTimeoutMin).toBe(60)
      expect(result.auth?.maxConcurrentSessions).toBe(5)
      expect(result.auth?.accountLockoutThreshold).toBe(10)
      expect(result.auth?.accountLockoutDurationMin).toBe(30)
      expect(result.auth?.allowedSignupDomains).toEqual([])
      expect(result.auth?.defaultUserRole).toBe('member')
    })

    it('uses DEFAULT_AUTH_SETTINGS when auth is absent', () => {
      mockSettingsFile(JSON.stringify({ container: { containerRunner: 'docker' } }))

      const result = loadSettings()

      expect(result.auth).toEqual({
        ...DEFAULT_AUTH_SETTINGS,
      })
    })

    it('preserves apiKeys as-is (no default merging)', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-test-123' },
        })
      )

      const result = loadSettings()

      expect(result.apiKeys).toEqual({ anthropicApiKey: 'sk-test-123' })
    })

    it('preserves agentLimits as-is', () => {
      const limits = { maxTurns: 10, maxBudgetUsd: 5 }
      mockSettingsFile(JSON.stringify({ agentLimits: limits }))

      const result = loadSettings()

      expect(result.agentLimits).toEqual(limits)
    })

    it('preserves customEnvVars as-is', () => {
      const envVars = { MY_VAR: 'hello', ANOTHER: 'world' }
      mockSettingsFile(JSON.stringify({ customEnvVars: envVars }))

      const result = loadSettings()

      expect(result.customEnvVars).toEqual(envVars)
    })

    it('preserves skillsets as-is', () => {
      const skillsets = [
        {
          id: 'test-skillset',
          url: 'https://github.com/example/skillset.git',
          name: 'Test',
          description: 'A test skillset',
          addedAt: '2025-01-01T00:00:00Z',
        },
      ]
      mockSettingsFile(JSON.stringify({ skillsets }))

      const result = loadSettings()

      expect(result.skillsets).toEqual(skillsets)
    })

    it('handles completely empty JSON object', () => {
      mockSettingsFile('{}')

      const result = loadSettings()

      // Container should be fully defaulted
      expect(result.container).toEqual(DEFAULT_SETTINGS.container)
      // App should be fully defaulted
      expect(result.app).toEqual(DEFAULT_SETTINGS.app)
      // Models should be fully defaulted
      expect(result.models).toEqual(DEFAULT_SETTINGS.models)
      // Auth should be fully defaulted
      expect(result.auth).toEqual(DEFAULT_AUTH_SETTINGS)
      // These should be undefined (no default)
      expect(result.apiKeys).toBeUndefined()
      expect(result.agentLimits).toBeUndefined()
      expect(result.customEnvVars).toBeUndefined()
      expect(result.skillsets).toBeUndefined()
    })
  })

  // --------------------------------------------------------------------------
  // Image tag migration
  // --------------------------------------------------------------------------

  describe('image tag migration', () => {
    const REGISTRY = 'ghcr.io/skillfulagents/superagent-agent-container-base'

    it('migrates :main tag to default image', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:main` },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('migrates semver tag (e.g. :0.2.0) to default image', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:0.2.0` },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('migrates complex semver tag (e.g. :1.23.456) to default image', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:1.23.456` },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('migrates semver-with-prerelease tag (e.g. :0.2.0-beta.1) to default image', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:0.2.0-beta.1` },
        })
      )

      const result = loadSettings()

      // The regex /^\d+\.\d+\.\d+/ matches "0.2.0-beta.1" because it starts with digits.digits.digits
      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('does NOT migrate :latest tag', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:latest` },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('does NOT migrate custom tag like :custom', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:custom` },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:custom`)
    })

    it('does NOT migrate a completely custom image', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: 'my-custom-registry.io/my-image:v1' },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe('my-custom-registry.io/my-image:v1')
    })

    it('does NOT migrate when agentImage is absent', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: 'docker' },
        })
      )

      const result = loadSettings()

      // Should get the default image
      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('does NOT migrate a tag that starts with digits but is not semver', () => {
      // e.g. "42abc" - the regex /^\d+\.\d+\.\d+/ requires dots
      mockSettingsFile(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:42abc` },
        })
      )

      const result = loadSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:42abc`)
    })
  })

  // --------------------------------------------------------------------------
  // useHostBrowser -> hostBrowserProvider migration
  // --------------------------------------------------------------------------

  describe('useHostBrowser to hostBrowserProvider migration', () => {
    it('migrates useHostBrowser=true to hostBrowserProvider=chrome', () => {
      mockSettingsFile(
        JSON.stringify({
          app: { useHostBrowser: true },
        })
      )

      const result = loadSettings()

      expect(result.app?.hostBrowserProvider).toBe('chrome')
    })

    it('does NOT migrate when useHostBrowser is false', () => {
      mockSettingsFile(
        JSON.stringify({
          app: { useHostBrowser: false },
        })
      )

      const result = loadSettings()

      expect(result.app?.hostBrowserProvider).toBeUndefined()
    })

    it('does NOT overwrite existing hostBrowserProvider', () => {
      mockSettingsFile(
        JSON.stringify({
          app: { useHostBrowser: true, hostBrowserProvider: 'browserbase' },
        })
      )

      const result = loadSettings()

      expect(result.app?.hostBrowserProvider).toBe('browserbase')
    })

    it('does NOT set hostBrowserProvider when useHostBrowser is absent', () => {
      mockSettingsFile(
        JSON.stringify({
          app: { showMenuBarIcon: false },
        })
      )

      const result = loadSettings()

      expect(result.app?.hostBrowserProvider).toBeUndefined()
    })
  })

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('preserves unknown extra fields at top level', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: 'docker' },
          unknownField: 'should-be-preserved-by-loaded-object',
        })
      )

      const result = loadSettings()

      // The merge spread does not explicitly include unknown top-level fields,
      // so they are NOT preserved in the returned object.
      // This tests the actual implementation behavior.
      expect((result as unknown as Record<string, unknown>).unknownField).toBeUndefined()
    })

    it('handles null values in settings', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: null },
          apiKeys: null,
        })
      )

      const result = loadSettings()

      // null container runner should overwrite the default via spread
      expect(result.container.containerRunner).toBeNull()
      expect(result.apiKeys).toBeNull()
    })

    it('handles empty string values', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: '' },
          apiKeys: { anthropicApiKey: '' },
        })
      )

      const result = loadSettings()

      expect(result.container.containerRunner).toBe('')
      expect(result.apiKeys?.anthropicApiKey).toBe('')
    })

    it('handles settings file with only apiKeys', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: {
            anthropicApiKey: 'sk-test',
            composioApiKey: 'ck-test',
          },
        })
      )

      const result = loadSettings()

      expect(result.apiKeys?.anthropicApiKey).toBe('sk-test')
      expect(result.apiKeys?.composioApiKey).toBe('ck-test')
      // Everything else should be defaulted
      expect(result.container).toEqual(DEFAULT_SETTINGS.container)
      expect(result.app).toEqual(DEFAULT_SETTINGS.app)
    })

    it('handles deeply nested partial overrides simultaneously', () => {
      mockSettingsFile(
        JSON.stringify({
          container: {
            containerRunner: 'podman',
            resourceLimits: { memory: '8g' },
          },
          app: {
            autoSleepTimeoutMinutes: 60,
            notifications: { enabled: false },
          },
          models: { agentModel: 'claude-sonnet-4-6' },
          auth: { signupMode: 'open' },
        })
      )

      const result = loadSettings()

      // Container
      expect(result.container.containerRunner).toBe('podman')
      expect(result.container.resourceLimits.cpu).toBe(2) // default
      expect(result.container.resourceLimits.memory).toBe('8g')

      // App
      expect(result.app?.autoSleepTimeoutMinutes).toBe(60)
      expect(result.app?.showMenuBarIcon).toBe(true) // default
      expect(result.app?.notifications?.enabled).toBe(false)
      expect(result.app?.notifications?.sessionComplete).toBe(true) // default

      // Models
      expect(result.models?.agentModel).toBe('claude-sonnet-4-6')
      expect(result.models?.summarizerModel).toBe('claude-haiku-4-5') // default

      // Auth
      expect(result.auth?.signupMode).toBe('open')
      expect(result.auth?.requireAdminApproval).toBe(true) // default
    })

    it('handles fs.existsSync returning true but readFileSync throwing', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      const result = loadSettings()

      expect(result).toEqual(DEFAULT_SETTINGS)
    })

    it('preserves extra fields inside container', () => {
      mockSettingsFile(
        JSON.stringify({
          container: {
            containerRunner: 'docker',
            customField: 'hello',
            resourceLimits: { cpu: 4, customLimit: true },
          },
        })
      )

      const result = loadSettings()

      // Extra fields within container are preserved by spread
      expect((result.container as unknown as Record<string, unknown>).customField).toBe('hello')
      // Extra fields within resourceLimits are preserved by spread
      expect(
        (result.container.resourceLimits as unknown as Record<string, unknown>).customLimit
      ).toBe(true)
    })

    it('preserves app-level extra preferences', () => {
      mockSettingsFile(
        JSON.stringify({
          app: {
            theme: 'dark',
            chromeProfileId: 'profile-123',
            allowPrereleaseUpdates: true,
            setupCompleted: true,
          },
        })
      )

      const result = loadSettings()

      expect(result.app?.theme).toBe('dark')
      expect(result.app?.chromeProfileId).toBe('profile-123')
      expect(result.app?.allowPrereleaseUpdates).toBe(true)
      expect(result.app?.setupCompleted).toBe(true)
    })
  })
})

// ============================================================================
// saveSettings()
// ============================================================================

describe('saveSettings', () => {
  it('writes settings to the correct path', () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.writeFileSync.mockImplementation(() => {})

    const settings = makeFullSettings()
    saveSettings(settings)

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      '/mock/data/dir/settings.json',
      JSON.stringify(settings, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    )
  })

  it('creates data directory if it does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false)
    mockedFs.mkdirSync.mockImplementation(() => '' as unknown as string)
    mockedFs.writeFileSync.mockImplementation(() => {})

    saveSettings(makeFullSettings())

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/mock/data/dir', { recursive: true })
  })

  it('does not create data directory if it already exists', () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.writeFileSync.mockImplementation(() => {})

    saveSettings(makeFullSettings())

    expect(mockedFs.mkdirSync).not.toHaveBeenCalled()
  })

  it('uses mode 0o600 for security', () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.writeFileSync.mockImplementation(() => {})

    saveSettings(makeFullSettings())

    const writeCall = mockedFs.writeFileSync.mock.calls[0]
    expect(writeCall[2]).toEqual({ encoding: 'utf-8', mode: 0o600 })
  })

  it('serializes with pretty-printed JSON (2-space indent)', () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.writeFileSync.mockImplementation(() => {})

    const settings = makeFullSettings()
    saveSettings(settings)

    const written = mockedFs.writeFileSync.mock.calls[0][1] as string
    expect(written).toBe(JSON.stringify(settings, null, 2))
    // Verify it contains newlines (pretty-printed)
    expect(written).toContain('\n')
  })
})

// ============================================================================
// Settings cache: getSettings(), clearSettingsCache(), updateSettings()
// ============================================================================

describe('settings cache', () => {
  describe('getSettings', () => {
    it('returns cached settings on second call without re-reading file', () => {
      mockNoSettingsFile()

      const first = getSettings()
      const second = getSettings()

      // Same reference means it was cached
      expect(first).toBe(second)
      // existsSync should only be called once (on first load)
      expect(mockedFs.existsSync).toHaveBeenCalledTimes(1)
    })

    it('loads from file on first call', () => {
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: 'podman' },
        })
      )

      const result = getSettings()

      expect(result.container.containerRunner).toBe('podman')
    })
  })

  describe('clearSettingsCache', () => {
    it('forces re-read on next getSettings call', () => {
      // First call: no file
      mockNoSettingsFile()
      const first = getSettings()
      expect(first.container.containerRunner).toBe('docker')

      // Now simulate file existing with different content
      clearSettingsCache()
      mockSettingsFile(
        JSON.stringify({
          container: { containerRunner: 'podman' },
        })
      )

      const second = getSettings()

      expect(second.container.containerRunner).toBe('podman')
      expect(first).not.toBe(second)
    })

    it('can be called multiple times safely', () => {
      clearSettingsCache()
      clearSettingsCache()
      clearSettingsCache()

      mockNoSettingsFile()
      const result = getSettings()
      expect(result).toEqual(DEFAULT_SETTINGS)
    })
  })

  describe('updateSettings', () => {
    it('saves settings and updates the cache', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => {})

      const newSettings = makeFullSettings({ container: { containerRunner: 'podman', agentImage: 'test', resourceLimits: { cpu: 4, memory: '8g' } } })
      updateSettings(newSettings)

      // Should have called saveSettings
      expect(mockedFs.writeFileSync).toHaveBeenCalled()

      // Cached value should be the new settings (without re-reading file)
      vi.clearAllMocks()
      const cached = getSettings()
      expect(cached).toBe(newSettings)
      // File should NOT be read again
      expect(mockedFs.existsSync).not.toHaveBeenCalled()
    })
  })
})

// ============================================================================
// API Key Status & Resolution
// ============================================================================

describe('Anthropic API key', () => {
  describe('getAnthropicApiKeyStatus', () => {
    it('returns settings source when key is in settings', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )

      const status = getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })

    it('returns env source when key is only in env', () => {
      mockNoSettingsFile()
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      const status = getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'env' })
    })

    it('returns none when key is not configured anywhere', () => {
      mockNoSettingsFile()
      delete process.env.ANTHROPIC_API_KEY

      const status = getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: false, source: 'none' })
    })

    it('prefers settings over env var', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      const status = getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })

    it('treats empty string as falsy (falls through to env)', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: '' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      const status = getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'env' })
    })

    it('treats empty string in both settings and env as none', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: '' },
        })
      )
      process.env.ANTHROPIC_API_KEY = ''

      const status = getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: false, source: 'none' })
    })
  })

  describe('getEffectiveAnthropicApiKey', () => {
    it('returns key from settings when configured', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )

      expect(getEffectiveAnthropicApiKey()).toBe('sk-from-settings')
    })

    it('falls back to env var when not in settings', () => {
      mockNoSettingsFile()
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(getEffectiveAnthropicApiKey()).toBe('sk-from-env')
    })

    it('returns undefined when not configured anywhere', () => {
      mockNoSettingsFile()
      delete process.env.ANTHROPIC_API_KEY

      expect(getEffectiveAnthropicApiKey()).toBeUndefined()
    })

    it('prefers settings over env var', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(getEffectiveAnthropicApiKey()).toBe('sk-from-settings')
    })

    it('returns env var when settings apiKeys is absent', () => {
      mockSettingsFile(JSON.stringify({}))
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(getEffectiveAnthropicApiKey()).toBe('sk-from-env')
    })

    it('returns env var when apiKeys exists but anthropicApiKey is empty string', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { anthropicApiKey: '' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(getEffectiveAnthropicApiKey()).toBe('sk-from-env')
    })
  })
})

describe('Composio API key', () => {
  describe('getComposioApiKeyStatus', () => {
    it('returns settings source when key is in settings', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { composioApiKey: 'ck-from-settings' },
        })
      )

      const status = getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })

    it('returns env source when key is only in env', () => {
      mockNoSettingsFile()
      process.env.COMPOSIO_API_KEY = 'ck-from-env'

      const status = getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'env' })
    })

    it('returns none when not configured', () => {
      mockNoSettingsFile()
      delete process.env.COMPOSIO_API_KEY

      const status = getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: false, source: 'none' })
    })

    it('prefers settings over env var', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { composioApiKey: 'ck-from-settings' },
        })
      )
      process.env.COMPOSIO_API_KEY = 'ck-from-env'

      const status = getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })
  })

  describe('getEffectiveComposioApiKey', () => {
    it('returns key from settings when configured', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { composioApiKey: 'ck-from-settings' },
        })
      )

      expect(getEffectiveComposioApiKey()).toBe('ck-from-settings')
    })

    it('falls back to env var', () => {
      mockNoSettingsFile()
      process.env.COMPOSIO_API_KEY = 'ck-from-env'

      expect(getEffectiveComposioApiKey()).toBe('ck-from-env')
    })

    it('returns undefined when not configured', () => {
      mockNoSettingsFile()
      delete process.env.COMPOSIO_API_KEY

      expect(getEffectiveComposioApiKey()).toBeUndefined()
    })
  })
})

describe('Composio user ID', () => {
  describe('getComposioUserId', () => {
    it('returns user ID from settings when configured', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { composioUserId: 'user-from-settings' },
        })
      )

      expect(getComposioUserId()).toBe('user-from-settings')
    })

    it('falls back to env var', () => {
      mockNoSettingsFile()
      process.env.COMPOSIO_USER_ID = 'user-from-env'

      expect(getComposioUserId()).toBe('user-from-env')
    })

    it('returns undefined when not configured', () => {
      mockNoSettingsFile()
      delete process.env.COMPOSIO_USER_ID

      expect(getComposioUserId()).toBeUndefined()
    })

    it('prefers settings over env var', () => {
      mockSettingsFile(
        JSON.stringify({
          apiKeys: { composioUserId: 'user-from-settings' },
        })
      )
      process.env.COMPOSIO_USER_ID = 'user-from-env'

      expect(getComposioUserId()).toBe('user-from-settings')
    })
  })
})

// ============================================================================
// getEffectiveModels()
// ============================================================================

describe('getEffectiveModels', () => {
  it('returns default models when no overrides', () => {
    mockNoSettingsFile()

    const models = getEffectiveModels()

    expect(models).toEqual({
      summarizerModel: 'claude-haiku-4-5',
      agentModel: 'claude-opus-4-6',
      browserModel: 'claude-sonnet-4-6',
    })
  })

  it('returns overridden models when configured', () => {
    mockSettingsFile(
      JSON.stringify({
        models: {
          summarizerModel: 'custom-summarizer',
          agentModel: 'custom-agent',
          browserModel: 'custom-browser',
        },
      })
    )

    const models = getEffectiveModels()

    expect(models).toEqual({
      summarizerModel: 'custom-summarizer',
      agentModel: 'custom-agent',
      browserModel: 'custom-browser',
    })
  })

  it('uses defaults for unset model fields', () => {
    mockSettingsFile(
      JSON.stringify({
        models: { agentModel: 'custom-agent' },
      })
    )

    const models = getEffectiveModels()

    expect(models.agentModel).toBe('custom-agent')
    expect(models.summarizerModel).toBe('claude-haiku-4-5')
    expect(models.browserModel).toBe('claude-sonnet-4-6')
  })

  it('falls back to defaults when model values are empty strings', () => {
    mockSettingsFile(
      JSON.stringify({
        models: {
          summarizerModel: '',
          agentModel: '',
          browserModel: '',
        },
      })
    )

    const models = getEffectiveModels()

    // Empty strings are falsy, so || fallback triggers
    expect(models.summarizerModel).toBe('claude-haiku-4-5')
    expect(models.agentModel).toBe('claude-opus-4-6')
    expect(models.browserModel).toBe('claude-sonnet-4-6')
  })

  it('handles models being undefined in settings', () => {
    mockSettingsFile(JSON.stringify({}))

    const models = getEffectiveModels()

    expect(models).toEqual({
      summarizerModel: 'claude-haiku-4-5',
      agentModel: 'claude-opus-4-6',
      browserModel: 'claude-sonnet-4-6',
    })
  })
})

// ============================================================================
// getEffectiveAgentLimits()
// ============================================================================

describe('getEffectiveAgentLimits', () => {
  it('returns empty object when no limits configured', () => {
    mockNoSettingsFile()

    expect(getEffectiveAgentLimits()).toEqual({})
  })

  it('returns configured limits', () => {
    mockSettingsFile(
      JSON.stringify({
        agentLimits: { maxTurns: 25, maxBudgetUsd: 10 },
      })
    )

    expect(getEffectiveAgentLimits()).toEqual({ maxTurns: 25, maxBudgetUsd: 10 })
  })

  it('returns full limits when all fields are set', () => {
    const limits = {
      maxOutputTokens: 4096,
      maxThinkingTokens: 2048,
      maxTurns: 50,
      maxBudgetUsd: 20,
    }
    mockSettingsFile(JSON.stringify({ agentLimits: limits }))

    expect(getEffectiveAgentLimits()).toEqual(limits)
  })
})

// ============================================================================
// getCustomEnvVars()
// ============================================================================

describe('getCustomEnvVars', () => {
  it('returns empty object when no custom env vars configured', () => {
    mockNoSettingsFile()

    expect(getCustomEnvVars()).toEqual({})
  })

  it('returns configured env vars', () => {
    const envVars = { FOO: 'bar', BAZ: 'qux' }
    mockSettingsFile(JSON.stringify({ customEnvVars: envVars }))

    expect(getCustomEnvVars()).toEqual(envVars)
  })

  it('returns empty object when customEnvVars is null', () => {
    mockSettingsFile(JSON.stringify({ customEnvVars: null }))

    expect(getCustomEnvVars()).toEqual({})
  })
})

// ============================================================================
// DEFAULT_SETTINGS export
// ============================================================================

describe('DEFAULT_SETTINGS', () => {
  it('has expected container defaults', () => {
    expect(DEFAULT_SETTINGS.container.containerRunner).toBe('docker')
    expect(DEFAULT_SETTINGS.container.agentImage).toBe(
      'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
    )
    expect(DEFAULT_SETTINGS.container.resourceLimits).toEqual({ cpu: 2, memory: '4g' })
  })

  it('has expected app defaults', () => {
    expect(DEFAULT_SETTINGS.app?.showMenuBarIcon).toBe(true)
    expect(DEFAULT_SETTINGS.app?.autoSleepTimeoutMinutes).toBe(30)
  })

  it('has expected notification defaults', () => {
    expect(DEFAULT_SETTINGS.app?.notifications).toEqual({
      enabled: true,
      sessionComplete: true,
      sessionWaiting: true,
      sessionScheduled: true,
    })
  })

  it('has expected model defaults', () => {
    expect(DEFAULT_SETTINGS.models).toEqual({
      summarizerModel: 'claude-haiku-4-5',
      agentModel: 'claude-opus-4-6',
      browserModel: 'claude-sonnet-4-6',
    })
  })
})

// ============================================================================
// DEFAULT_AUTH_SETTINGS export
// ============================================================================

describe('DEFAULT_AUTH_SETTINGS', () => {
  it('has all expected default values', () => {
    expect(DEFAULT_AUTH_SETTINGS).toEqual({
      signupMode: 'invitation_only',
      allowedSignupDomains: [],
      requireAdminApproval: true,
      defaultUserRole: 'member',
      allowLocalAuth: true,
      allowSocialAuth: false,
      passwordMinLength: 12,
      passwordMaxLength: 128,
      passwordRequireComplexity: true,
      sessionMaxLifetimeHrs: 24,
      sessionIdleTimeoutMin: 60,
      maxConcurrentSessions: 5,
      accountLockoutThreshold: 10,
      accountLockoutDurationMin: 30,
    })
  })
})

// ============================================================================
// Integration-style scenarios
// ============================================================================

describe('integration scenarios', () => {
  it('full settings round-trip: load defaults, customize, save, reload', () => {
    // 1. Start with no file
    mockNoSettingsFile()
    const defaults = loadSettings()

    // 2. Customize some values
    const customized: AppSettings = {
      ...defaults,
      container: {
        ...defaults.container,
        containerRunner: 'podman',
        resourceLimits: { cpu: 8, memory: '16g' },
      },
      apiKeys: { anthropicApiKey: 'sk-test-123' },
    }

    // 3. Save
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.writeFileSync.mockImplementation(() => {})
    saveSettings(customized)

    // 4. Simulate reload by mocking the file with what was saved
    const savedContent = (mockedFs.writeFileSync.mock.calls[0][1] as string)
    clearSettingsCache()
    mockSettingsFile(savedContent)

    const reloaded = loadSettings()
    expect(reloaded.container.containerRunner).toBe('podman')
    expect(reloaded.container.resourceLimits).toEqual({ cpu: 8, memory: '16g' })
    expect(reloaded.apiKeys?.anthropicApiKey).toBe('sk-test-123')
  })

  it('cache works across multiple getSettings-dependent functions', () => {
    mockSettingsFile(
      JSON.stringify({
        apiKeys: {
          anthropicApiKey: 'sk-test',
          composioApiKey: 'ck-test',
          composioUserId: 'uid-test',
        },
        models: { agentModel: 'custom-model' },
        agentLimits: { maxTurns: 10 },
        customEnvVars: { MY_VAR: 'hello' },
      })
    )

    // All of these should use the same cached settings
    getAnthropicApiKeyStatus()
    getEffectiveAnthropicApiKey()
    getComposioApiKeyStatus()
    getEffectiveComposioApiKey()
    getComposioUserId()
    getEffectiveModels()
    getEffectiveAgentLimits()
    getCustomEnvVars()

    // File should only be read once
    expect(mockedFs.readFileSync).toHaveBeenCalledTimes(1)
  })

  it('updateSettings overwrites cache so subsequent reads reflect changes', () => {
    mockNoSettingsFile()

    // Initial read: defaults
    const initial = getSettings()
    expect(initial.container.containerRunner).toBe('docker')

    // Update
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.writeFileSync.mockImplementation(() => {})
    const updated = makeFullSettings({
      container: {
        containerRunner: 'podman',
        agentImage: 'test:latest',
        resourceLimits: { cpu: 4, memory: '8g' },
      },
    })
    updateSettings(updated)

    // Now getSettings should return the updated value without reading file
    const afterUpdate = getSettings()
    expect(afterUpdate.container.containerRunner).toBe('podman')
    // readFileSync should only have been called once (the initial load)
    expect(mockedFs.readFileSync).not.toHaveBeenCalled()
  })
})
