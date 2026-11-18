import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies before importing the module under test
vi.mock('./version', () => ({
  AGENT_IMAGE_REGISTRY: 'ghcr.io/skillfulagents/superagent-agent-container-base',
  getDefaultAgentImage: vi.fn(
    () => 'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
  ),
}))
// Not importOriginal: the real module's Sentry provider imports ./settings,
// which would then bind to the real captureException.
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))
// Records default to the app database: this file's own test database.
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import { captureException } from '@shared/lib/error-reporting'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import * as records from '@shared/lib/app-records/records'
import {
  compareAndSetRecord,
  insertRecordIfAbsent,
  InvalidAppRecordError,
  readStoredRecord,
} from '@shared/lib/app-records/records'
import { SETTINGS_RECORD_KEY } from '@shared/lib/app-records/record-schemas'
import {
  getSettings,
  loadSettingsStrict,
  readSettingsSnapshot,
  mutateSettings,
  getAnthropicApiKeyStatus,
  getEffectiveAnthropicApiKey,
  getComposioApiKeyStatus,
  getEffectiveComposioApiKey,
  getComposioUserId,
  getAccountProviderUserId,
  getEffectiveModels,
  getEffectiveAgentLimits,
  getModelCatalogSettings,
  getCustomEnvVars,
  DEFAULT_SETTINGS,
  DEFAULT_AUTH_SETTINGS,
  isAutoResumeOnUnexpectedDeathEnabled,
} from './settings'

// ============================================================================
// Helpers
// ============================================================================

let handle: TestDatabase
let testDb: TestDatabase['db']

/**
 * Store raw text as the settings record (revision 1), as if a previous write
 * (or a bad migration) had left it there. Raw so invalid values can be stored
 * too. Nothing stored at all is simply no row.
 */
async function storeSettings(value: string) {
  if (!(await insertRecordIfAbsent(SETTINGS_RECORD_KEY, value))) throw new Error('settings are already stored')
}

/** The settings record as stored, parsed. */
async function storedSettings(): Promise<Record<string, any>> {
  const row = await readStoredRecord(SETTINGS_RECORD_KEY)
  if (!row) throw new Error('no settings stored')
  return JSON.parse(row.value)
}

// ============================================================================
// Setup & Teardown
// ============================================================================

const originalEnv = { ...process.env }

beforeEach(async () => {
  vi.clearAllMocks()
  handle = await createTestDatabase()
  testDb = handle.db
  // Reset env vars that could interfere
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.COMPOSIO_API_KEY
  delete process.env.COMPOSIO_USER_ID
})

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  await handle.close()
})

// ============================================================================
// getSettings() (tolerant read)
// ============================================================================

describe('getSettings', () => {
  // --------------------------------------------------------------------------
  // Missing / empty / invalid stored value
  // --------------------------------------------------------------------------

  describe('when no settings are stored', () => {
    it('returns default settings', async () => {
      const result = await getSettings()

      expect(result).toEqual(DEFAULT_SETTINGS)
    })

    it('returns a fresh copy each time, not the same reference', async () => {
      const a = await getSettings()
      const b = await getSettings()

      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })

    it('returns defaults a caller can mutate without changing the next read', async () => {
      const a = await getSettings()
      a.container.resourceLimits.cpu = 99
      a.skillsets!.push({ ...a.skillsets![0], id: 'pushed' })

      expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
      expect(DEFAULT_SETTINGS.container.resourceLimits.cpu).toBe(2)
    })
  })

  describe('when the stored value is invalid', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleSpy.mockRestore()
    })

    it.each([
      ['an empty string', ''],
      ['invalid JSON', '{not valid json!!!'],
      ['a JSON array', '[1, 2]'],
      ['JSON null', 'null'],
    ])('returns default settings for %s', async (_label, value) => {
      await storeSettings(value)

      const result = await getSettings()

      expect(result).toEqual(DEFAULT_SETTINGS)
    })

    it('logs and reports the error, and throws nothing', async () => {
      await storeSettings('totally broken')

      await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)

      // Degrades to in-memory defaults WITHOUT overwriting the stored value.
      expect(consoleSpy).toHaveBeenCalledWith(
        'Stored settings are invalid; using defaults (NOT overwriting them):',
        expect.any(InvalidAppRecordError)
      )
      expect(captureException).toHaveBeenCalledWith(
        expect.any(InvalidAppRecordError),
        { tags: { area: 'settings', op: 'load' } }
      )
      expect(await readStoredRecord(SETTINGS_RECORD_KEY)).toEqual({ value: 'totally broken', revision: 1 })
    })
  })

  describe('when the database fails', () => {
    it('propagates the error instead of degrading to defaults', async () => {
      vi.spyOn(records, 'readStoredRecord').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))

      await expect(getSettings()).rejects.toThrow('SQLITE_BUSY')
      expect(captureException).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // Deep merge with defaults
  // --------------------------------------------------------------------------

  describe('deep merge with defaults', () => {
    it('merges partial container settings with defaults', async () => {
      await storeSettings(
        JSON.stringify({
          container: { containerRunner: 'podman' },
        })
      )

      const result = await getSettings()

      expect(result.container.containerRunner).toBe('podman')
      // Default agentImage should be applied (via getDefaultAgentImage mock)
      expect(result.container.agentImage).toBe(
        'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
      )
      expect(result.container.resourceLimits).toEqual({ cpu: 2, memory: '4g' })
    })

    it('merges partial resourceLimits with defaults', async () => {
      await storeSettings(
        JSON.stringify({
          container: {
            containerRunner: 'docker',
            resourceLimits: { cpu: 8 },
          },
        })
      )

      const result = await getSettings()

      expect(result.container.resourceLimits.cpu).toBe(8)
      expect(result.container.resourceLimits.memory).toBe('4g') // default
    })

    it('merges partial notification settings with defaults', async () => {
      await storeSettings(
        JSON.stringify({
          app: {
            notifications: { sessionComplete: false },
          },
        })
      )

      const result = await getSettings()

      expect(result.app?.notifications?.sessionComplete).toBe(false)
      expect(result.app?.notifications?.enabled).toBe(true) // default
      expect(result.app?.notifications?.sessionWaiting).toBe(true) // default
      expect(result.app?.notifications?.sessionScheduled).toBe(true) // default
    })

    it('merges partial app preferences with defaults', async () => {
      await storeSettings(
        JSON.stringify({
          app: { showMenuBarIcon: false },
        })
      )

      const result = await getSettings()

      expect(result.app?.showMenuBarIcon).toBe(false)
      expect(result.app?.autoSleepTimeoutMinutes).toBe(30) // default
      // notifications still get defaults
      expect(result.app?.notifications?.enabled).toBe(true)
    })

    it('merges partial model settings with defaults', async () => {
      await storeSettings(
        JSON.stringify({
          // A genuine pin (older non-default version) — must survive untouched.
          models: { agentModel: 'claude-opus-4-7' },
        })
      )

      const result = await getSettings()

      expect(result.models?.agentModel).toBe('claude-opus-4-7')
      expect(result.models?.summarizerModel).toBe('haiku') // default
      expect(result.models?.browserModel).toBe('haiku') // default
    })

    it('migrates legacy concrete model defaults to bare family aliases', async () => {
      // Pre-SUP-275 persisted the three defaults as concrete ids. These have no
      // Bedrock catalog entry and would pass straight through (and fail) there,
      // so the settings read rewrites them to bare aliases that resolve per provider.
      await storeSettings(
        JSON.stringify({
          models: {
            summarizerModel: 'claude-haiku-4-5',
            agentModel: 'claude-opus-4-8',
            browserModel: 'claude-sonnet-4-6',
            agentEffort: 'high',
          },
        })
      )

      const result = await getSettings()

      expect(result.models?.summarizerModel).toBe('haiku')
      expect(result.models?.agentModel).toBe('opus')
      expect(result.models?.browserModel).toBe('sonnet')
      // Non-model fields are untouched by the migration.
      expect(result.models?.agentEffort).toBe('high')
    })

    it('preserves the web provider selection', async () => {
      await storeSettings(JSON.stringify({ webProvider: 'exa' }))

      const result = await getSettings()

      expect(result.webProvider).toBe('exa')
    })

    it('recovers a legacy webSearchProvider selection on upgrade (pre-collapse installs)', async () => {
      await storeSettings(JSON.stringify({ webSearchProvider: 'exa' }))

      const result = await getSettings()

      expect(result.webProvider).toBe('exa')
    })

    it('preserves the web allow/deny site lists', async () => {
      await storeSettings(JSON.stringify({ webAllowedSites: ['nytimes.com'], webBlockedSites: ['evil.com'] }))

      const result = await getSettings()

      expect(result.webAllowedSites).toEqual(['nytimes.com'])
      expect(result.webBlockedSites).toEqual(['evil.com'])
    })

    it('merges auth settings with defaults', async () => {
      await storeSettings(
        JSON.stringify({
          auth: { signupMode: 'open', passwordMinLength: 8 },
        })
      )

      const result = await getSettings()

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

    it('uses DEFAULT_AUTH_SETTINGS when auth is absent', async () => {
      await storeSettings(JSON.stringify({ container: { containerRunner: 'docker' } }))

      const result = await getSettings()

      expect(result.auth).toEqual({
        ...DEFAULT_AUTH_SETTINGS,
      })
    })

    it('preserves apiKeys as-is (no default merging)', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-test-123' },
        })
      )

      const result = await getSettings()

      expect(result.apiKeys).toEqual({ anthropicApiKey: 'sk-test-123' })
    })

    it('preserves agentLimits as-is', async () => {
      const limits = { maxTurns: 10, maxBudgetUsd: 5 }
      await storeSettings(JSON.stringify({ agentLimits: limits }))

      const result = await getSettings()

      expect(result.agentLimits).toEqual(limits)
    })

    it('preserves app.autoDeleteInactiveDays', async () => {
      await storeSettings(JSON.stringify({ app: { autoDeleteInactiveDays: 30 } }))

      const result = await getSettings()

      expect(result.app?.autoDeleteInactiveDays).toBe(30)
    })

    it('preserves app.autoDeleteInactiveDays = 0 (disabled)', async () => {
      await storeSettings(JSON.stringify({ app: { autoDeleteInactiveDays: 0 } }))

      const result = await getSettings()

      expect(result.app?.autoDeleteInactiveDays).toBe(0)
    })

    it('leaves autoDeleteInactiveDays undefined when not set', async () => {
      await storeSettings(JSON.stringify({}))

      const result = await getSettings()

      expect(result.app?.autoDeleteInactiveDays).toBeUndefined()
    })

    it('defaults app.apiLogAutoDeleteDays to 30 when not set', async () => {
      await storeSettings(JSON.stringify({}))

      const result = await getSettings()

      expect(result.app?.apiLogAutoDeleteDays).toBe(30)
    })

    it('preserves app.apiLogAutoDeleteDays = 0 (Never)', async () => {
      await storeSettings(JSON.stringify({ app: { apiLogAutoDeleteDays: 0 } }))

      const result = await getSettings()

      expect(result.app?.apiLogAutoDeleteDays).toBe(0)
    })

    it('preserves app.apiLogAutoDeleteDays = 90', async () => {
      await storeSettings(JSON.stringify({ app: { apiLogAutoDeleteDays: 90 } }))

      const result = await getSettings()

      expect(result.app?.apiLogAutoDeleteDays).toBe(90)
    })

    it('defaults app.globalDispatchShortcut to Control+Shift+Space when not set', async () => {
      await storeSettings(JSON.stringify({}))

      expect((await getSettings()).app?.globalDispatchShortcut).toBe('Control+Shift+Space')
    })

    it('moves the earlier persisted default launcher shortcut to the current default', async () => {
      // Every settings write persisted the merged defaults, so existing installs
      // carry the old default without having chosen it.
      await storeSettings(JSON.stringify({ app: { globalDispatchShortcut: 'CommandOrControl+Shift+Space' } }))

      expect((await getSettings()).app?.globalDispatchShortcut).toBe('Control+Shift+Space')
    })

    it('keeps a launcher shortcut the user recorded, including ⌘⇧Space', async () => {
      await storeSettings(JSON.stringify({ app: { globalDispatchShortcut: 'Command+Shift+Space' } }))

      expect((await getSettings()).app?.globalDispatchShortcut).toBe('Command+Shift+Space')
    })

    it('keeps the launcher disabled when the shortcut is empty', async () => {
      await storeSettings(JSON.stringify({ app: { globalDispatchShortcut: '' } }))

      expect((await getSettings()).app?.globalDispatchShortcut).toBe('')
    })

    it('preserves customEnvVars as-is', async () => {
      const envVars = { MY_VAR: 'hello', ANOTHER: 'world' }
      await storeSettings(JSON.stringify({ customEnvVars: envVars }))

      const result = await getSettings()

      expect(result.customEnvVars).toEqual(envVars)
    })

    it('preserves a valid modelCatalog override map', async () => {
      const modelCatalog = {
        anthropic: {
          overrides: [{ id: 'claude-opus-4-8', disabled: true }],
        },
      }
      await storeSettings(JSON.stringify({ modelCatalog }))

      const result = await getSettings()

      expect(result.modelCatalog).toEqual(modelCatalog)
    })

    it('drops one unreadable global price without failing the load or losing the others', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const good = { inputPerMtok: 1, outputPerMtok: 2 }
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-kept' },
          modelPricing: { good, bad: { inputPerMtok: -1, outputPerMtok: 2 }, worse: 'free' },
        }),
      )

      const result = await getSettings()

      expect(result.modelPricing).toEqual({ good })
      expect(result.apiKeys?.anthropicApiKey).toBe('sk-kept')
      expect(warn).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })

    it('ignores a modelPricing value that is not a map', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await storeSettings(JSON.stringify({ modelPricing: [1, 2] }))

      expect((await getSettings()).modelPricing).toEqual({})
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })

    it('ignores a malformed modelCatalog instead of failing settings load', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await storeSettings(JSON.stringify({ modelCatalog: { anthropic: { overrides: [{ id: '' }] } } }))

      const result = await getSettings()

      expect(result.modelCatalog).toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })

    it('preserves skillsets as-is', async () => {
      const skillsets = [
        {
          id: 'test-skillset',
          url: 'https://github.com/example/skillset.git',
          name: 'Test',
          description: 'A test skillset',
          addedAt: '2025-01-01T00:00:00Z',
        },
      ]
      await storeSettings(JSON.stringify({ skillsets }))

      const result = await getSettings()

      expect(result.skillsets).toEqual(skillsets)
    })

    it('preserves skillset credentials without copying them into skillset metadata', async () => {
      const skillsetCredentials = {
        skillcred_test: {
          id: 'skillcred_test',
          type: 'token',
          token: 'github_pat_secret',
          tokenPreview: '••••cret',
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
        },
      }
      await storeSettings(JSON.stringify({ skillsetCredentials }))

      const result = await getSettings()

      expect(result.skillsetCredentials).toEqual(skillsetCredentials)
      expect(JSON.stringify(result.skillsets)).not.toContain('github_pat_secret')
    })

    it('handles completely empty JSON object', async () => {
      await storeSettings('{}')

      const result = await getSettings()

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
      expect(result.modelCatalog).toBeUndefined()
      expect(result.skillsets).toEqual(DEFAULT_SETTINGS.skillsets)
    })
  })

  // --------------------------------------------------------------------------
  // Image tag migration
  // --------------------------------------------------------------------------

  describe('image tag migration', () => {
    const REGISTRY = 'ghcr.io/skillfulagents/superagent-agent-container-base'

    it('migrates :main tag to default image', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:main` },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('migrates semver tag (e.g. :0.2.0) to default image', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:0.2.0` },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('migrates complex semver tag (e.g. :1.23.456) to default image', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:1.23.456` },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('migrates semver-with-prerelease tag (e.g. :0.2.0-beta.1) to default image', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:0.2.0-beta.1` },
        })
      )

      const result = await getSettings()

      // The regex /^\d+\.\d+\.\d+/ matches "0.2.0-beta.1" because it starts with digits.digits.digits
      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('does NOT migrate :latest tag', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:latest` },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('does NOT migrate custom tag like :custom', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:custom` },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:custom`)
    })

    it('does NOT migrate a completely custom image', async () => {
      await storeSettings(
        JSON.stringify({
          container: { agentImage: 'my-custom-registry.io/my-image:v1' },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe('my-custom-registry.io/my-image:v1')
    })

    it('does NOT migrate when agentImage is absent', async () => {
      await storeSettings(
        JSON.stringify({
          container: { containerRunner: 'docker' },
        })
      )

      const result = await getSettings()

      // Should get the default image
      expect(result.container.agentImage).toBe(`${REGISTRY}:latest`)
    })

    it('does NOT migrate a tag that starts with digits but is not semver', async () => {
      // e.g. "42abc" - the regex /^\d+\.\d+\.\d+/ requires dots
      await storeSettings(
        JSON.stringify({
          container: { agentImage: `${REGISTRY}:42abc` },
        })
      )

      const result = await getSettings()

      expect(result.container.agentImage).toBe(`${REGISTRY}:42abc`)
    })
  })

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('preserves unknown extra fields at top level', async () => {
      await storeSettings(
        JSON.stringify({
          container: { containerRunner: 'docker' },
          unknownField: 'should-be-preserved-by-loaded-object',
        })
      )

      const result = await getSettings()

      // The merge spread does not explicitly include unknown top-level fields,
      // so they are NOT preserved in the returned object.
      // This tests the actual implementation behavior.
      expect((result as unknown as Record<string, unknown>).unknownField).toBeUndefined()
    })

    it('handles null values in settings', async () => {
      await storeSettings(
        JSON.stringify({
          container: { containerRunner: null },
          apiKeys: null,
        })
      )

      const result = await getSettings()

      // null container runner should overwrite the default via spread
      expect(result.container.containerRunner).toBeNull()
      expect(result.apiKeys).toBeNull()
    })

    it('handles empty string values', async () => {
      await storeSettings(
        JSON.stringify({
          container: { containerRunner: '' },
          apiKeys: { anthropicApiKey: '' },
        })
      )

      const result = await getSettings()

      expect(result.container.containerRunner).toBe('')
      expect(result.apiKeys?.anthropicApiKey).toBe('')
    })

    it('handles stored settings with only apiKeys', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: {
            anthropicApiKey: 'sk-test',
            composioApiKey: 'ck-test',
          },
        })
      )

      const result = await getSettings()

      expect(result.apiKeys?.anthropicApiKey).toBe('sk-test')
      expect(result.apiKeys?.composioApiKey).toBe('ck-test')
      // Everything else should be defaulted
      expect(result.container).toEqual(DEFAULT_SETTINGS.container)
      expect(result.app).toEqual(DEFAULT_SETTINGS.app)
    })

    it('handles deeply nested partial overrides simultaneously', async () => {
      await storeSettings(
        JSON.stringify({
          container: {
            containerRunner: 'podman',
            resourceLimits: { memory: '8g' },
          },
          app: {
            autoSleepTimeoutMinutes: 60,
            notifications: { enabled: false },
          },
          models: { agentModel: 'claude-opus-4-7' },
          auth: { signupMode: 'open' },
        })
      )

      const result = await getSettings()

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
      expect(result.models?.agentModel).toBe('claude-opus-4-7')
      expect(result.models?.summarizerModel).toBe('haiku') // default

      // Auth
      expect(result.auth?.signupMode).toBe('open')
      expect(result.auth?.requireAdminApproval).toBe(true) // default
    })

    it('preserves extra fields inside container', async () => {
      await storeSettings(
        JSON.stringify({
          container: {
            containerRunner: 'docker',
            customField: 'hello',
            resourceLimits: { cpu: 4, customLimit: true },
          },
        })
      )

      const result = await getSettings()

      // Extra fields within container are preserved by spread
      expect((result.container as unknown as Record<string, unknown>).customField).toBe('hello')
      // Extra fields within resourceLimits are preserved by spread
      expect(
        (result.container.resourceLimits as unknown as Record<string, unknown>).customLimit
      ).toBe(true)
    })

    it('preserves app-level extra preferences', async () => {
      await storeSettings(
        JSON.stringify({
          app: {
            theme: 'dark',
            chromeHeadless: true,
            allowPrereleaseUpdates: true,
            setupCompleted: true,
          },
        })
      )

      const result = await getSettings()

      expect(result.app?.theme).toBe('dark')
      expect(result.app?.chromeHeadless).toBe(true)
      expect(result.app?.allowPrereleaseUpdates).toBe(true)
      expect(result.app?.setupCompleted).toBe(true)
    })
  })
})

// ============================================================================
// Strict reads: readSettingsSnapshot(), loadSettingsStrict()
// ============================================================================

describe('strict reads', () => {
  it('reads defaults at revision 0 when nothing is stored', async () => {
    const snapshot = await readSettingsSnapshot()

    expect(snapshot).toEqual({ settings: DEFAULT_SETTINGS, revision: 0 })
  })

  it('reads the stored settings with their revision', async () => {
    await storeSettings(JSON.stringify({ container: { containerRunner: 'docker' } }))
    await compareAndSetRecord(SETTINGS_RECORD_KEY, 1, JSON.stringify({ container: { containerRunner: 'podman' } }))

    const snapshot = await readSettingsSnapshot()

    expect(snapshot.revision).toBe(2)
    expect(snapshot.settings.container.containerRunner).toBe('podman')
  })

  it.each([
    ['invalid JSON', '{not valid json!!!'],
    ['a JSON array', '[]'],
  ])('throws InvalidAppRecordError for %s, without logging or reporting', async (_label, value) => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await storeSettings(value)

    await expect(loadSettingsStrict()).rejects.toBeInstanceOf(InvalidAppRecordError)
    expect(consoleSpy).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})

// ============================================================================
// mutateSettings()
// ============================================================================

describe('mutateSettings', () => {
  it('stores the merged settings as JSON under the settings key at revision 1', async () => {
    const written = await mutateSettings((s) => {
      s.container.containerRunner = 'podman'
    })

    expect(written.container.containerRunner).toBe('podman')
    expect((await readStoredRecord(SETTINGS_RECORD_KEY))?.revision).toBe(1)
    expect(await storedSettings()).toEqual(written)
    // The merged defaults are stored too, not only the changed field.
    expect((await storedSettings()).app.notifications).toEqual(DEFAULT_SETTINGS.app?.notifications)
  })

  it('bumps the revision on the next write and keeps the earlier change', async () => {
    await mutateSettings((s) => {
      s.container.containerRunner = 'podman'
    })
    await mutateSettings((s) => {
      s.apiKeys = { anthropicApiKey: 'sk-test-123' }
    })

    expect((await readStoredRecord(SETTINGS_RECORD_KEY))?.revision).toBe(2)
    expect((await storedSettings()).container.containerRunner).toBe('podman')
    expect((await storedSettings()).apiKeys).toEqual({ anthropicApiKey: 'sk-test-123' })
  })

  it('writes nothing when the mutator returns false', async () => {
    const result = await mutateSettings(() => false)

    expect(result).toEqual(DEFAULT_SETTINGS)
    expect(await readStoredRecord(SETTINGS_RECORD_KEY)).toBeNull()
  })

  it('refuses to replace an invalid stored value with defaults', async () => {
    await storeSettings('{not valid json!!!')

    await expect(
      mutateSettings((s) => {
        s.container.containerRunner = 'podman'
      }),
    ).rejects.toBeInstanceOf(InvalidAppRecordError)
    expect(await readStoredRecord(SETTINGS_RECORD_KEY)).toEqual({ value: '{not valid json!!!', revision: 1 })
  })
})

// ============================================================================
// No settings cache: every getSettings() reads the database
// ============================================================================

describe('no settings cache', () => {
  it('reads the database on every call and returns distinct objects', async () => {
    await storeSettings(JSON.stringify({ container: { containerRunner: 'podman' } }))
    const reads = vi.spyOn(records, 'readStoredRecord')

    const first = await getSettings()
    const second = await getSettings()

    expect(reads).toHaveBeenCalledTimes(2)
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
    expect(first.container.containerRunner).toBe('podman')
  })

  it('sees a value changed in the database between two calls', async () => {
    const first = await getSettings()
    expect(first.container.containerRunner).toBe(DEFAULT_SETTINGS.container.containerRunner)

    // Another process writes the row.
    await storeSettings(JSON.stringify({ container: { containerRunner: 'podman' } }))

    const second = await getSettings()
    expect(second.container.containerRunner).toBe('podman')
  })

  it('sees a write made through mutateSettings on the next read', async () => {
    await mutateSettings((s) => {
      s.container = {
        containerRunner: 'podman',
        agentImage: 'test',
        resourceLimits: { cpu: 4, memory: '8g' },
      }
    })
    const reads = vi.spyOn(records, 'readStoredRecord')

    const after = await getSettings()

    expect(reads).toHaveBeenCalledTimes(1)
    expect(after.container.containerRunner).toBe('podman')
    expect(after.container.agentImage).toBe('test')
    expect(after.container.resourceLimits).toEqual({ cpu: 4, memory: '8g' })
  })
})

// ============================================================================
// API Key Status & Resolution
// ============================================================================

describe('Anthropic API key', () => {
  describe('getAnthropicApiKeyStatus', () => {
    it('returns settings source when key is in settings', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )

      const status = await getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })

    it('returns env source when key is only in env', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      const status = await getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'env' })
    })

    it('returns none when key is not configured anywhere', async () => {
      delete process.env.ANTHROPIC_API_KEY

      const status = await getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: false, source: 'none' })
    })

    it('prefers settings over env var', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      const status = await getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })

    it('treats empty string as falsy (falls through to env)', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: '' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      const status = await getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'env' })
    })

    it('treats empty string in both settings and env as none', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: '' },
        })
      )
      process.env.ANTHROPIC_API_KEY = ''

      const status = await getAnthropicApiKeyStatus()

      expect(status).toEqual({ isConfigured: false, source: 'none' })
    })
  })

  describe('getEffectiveAnthropicApiKey', () => {
    it('returns key from settings when configured', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )

      expect(await getEffectiveAnthropicApiKey()).toBe('sk-from-settings')
    })

    it('falls back to env var when not in settings', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(await getEffectiveAnthropicApiKey()).toBe('sk-from-env')
    })

    it('returns undefined when not configured anywhere', async () => {
      delete process.env.ANTHROPIC_API_KEY

      expect(await getEffectiveAnthropicApiKey()).toBeUndefined()
    })

    it('prefers settings over env var', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: 'sk-from-settings' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(await getEffectiveAnthropicApiKey()).toBe('sk-from-settings')
    })

    it('returns env var when settings apiKeys is absent', async () => {
      await storeSettings(JSON.stringify({}))
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(await getEffectiveAnthropicApiKey()).toBe('sk-from-env')
    })

    it('returns env var when apiKeys exists but anthropicApiKey is empty string', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { anthropicApiKey: '' },
        })
      )
      process.env.ANTHROPIC_API_KEY = 'sk-from-env'

      expect(await getEffectiveAnthropicApiKey()).toBe('sk-from-env')
    })
  })
})

describe('Composio API key', () => {
  describe('getComposioApiKeyStatus', () => {
    it('returns settings source when key is in settings', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { composioApiKey: 'ck-from-settings' },
        })
      )

      const status = await getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })

    it('returns env source when key is only in env', async () => {
      process.env.COMPOSIO_API_KEY = 'ck-from-env'

      const status = await getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'env' })
    })

    it('returns none when not configured', async () => {
      delete process.env.COMPOSIO_API_KEY

      const status = await getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: false, source: 'none' })
    })

    it('prefers settings over env var', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { composioApiKey: 'ck-from-settings' },
        })
      )
      process.env.COMPOSIO_API_KEY = 'ck-from-env'

      const status = await getComposioApiKeyStatus()

      expect(status).toEqual({ isConfigured: true, source: 'settings' })
    })
  })

  describe('getEffectiveComposioApiKey', () => {
    it('returns key from settings when configured', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { composioApiKey: 'ck-from-settings' },
        })
      )

      expect(await getEffectiveComposioApiKey()).toBe('ck-from-settings')
    })

    it('falls back to env var', async () => {
      process.env.COMPOSIO_API_KEY = 'ck-from-env'

      expect(await getEffectiveComposioApiKey()).toBe('ck-from-env')
    })

    it('returns undefined when not configured', async () => {
      delete process.env.COMPOSIO_API_KEY

      expect(await getEffectiveComposioApiKey()).toBeUndefined()
    })
  })
})

describe('Composio user ID', () => {
  describe('getComposioUserId', () => {
    it('returns user ID from settings when configured', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { composioUserId: 'user-from-settings' },
        })
      )

      expect(await getComposioUserId()).toBe('user-from-settings')
    })

    it('falls back to env var', async () => {
      process.env.COMPOSIO_USER_ID = 'user-from-env'

      expect(await getComposioUserId()).toBe('user-from-env')
    })

    it('returns undefined when not configured', async () => {
      delete process.env.COMPOSIO_USER_ID

      expect(await getComposioUserId()).toBeUndefined()
    })

    it('prefers settings over env var', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { composioUserId: 'user-from-settings' },
        })
      )
      process.env.COMPOSIO_USER_ID = 'user-from-env'

      expect(await getComposioUserId()).toBe('user-from-settings')
    })
  })
})

describe('Account provider user ID', () => {
  describe('getAccountProviderUserId', () => {
    it('returns the account provider user ID from settings when configured', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { accountProviderUserId: 'acct-from-settings', composioUserId: 'user-from-settings' },
        })
      )
      process.env.COMPOSIO_USER_ID = 'user-from-env'

      expect(await getAccountProviderUserId()).toBe('acct-from-settings')
    })

    it('falls back to the Composio user ID from settings', async () => {
      await storeSettings(
        JSON.stringify({
          apiKeys: { composioUserId: 'user-from-settings' },
        })
      )
      process.env.COMPOSIO_USER_ID = 'user-from-env'
      const reads = vi.spyOn(records, 'readStoredRecord')

      expect(await getAccountProviderUserId()).toBe('user-from-settings')
      // One read serves both lookups.
      expect(reads).toHaveBeenCalledTimes(1)
    })

    it('falls back to the COMPOSIO_USER_ID env var', async () => {
      process.env.COMPOSIO_USER_ID = 'user-from-env'

      expect(await getAccountProviderUserId()).toBe('user-from-env')
    })

    it('returns undefined when not configured', async () => {
      expect(await getAccountProviderUserId()).toBeUndefined()
    })
  })
})

// ============================================================================
// getEffectiveModels()
// ============================================================================

describe('getEffectiveModels', () => {
  it('returns default models when no overrides', async () => {
    const models = await getEffectiveModels()

    expect(models).toEqual({
      summarizerModel: 'haiku',
      agentModel: 'opus',
      browserModel: 'haiku',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    })
  })

  it('returns overridden models when configured', async () => {
    await storeSettings(
      JSON.stringify({
        models: {
          summarizerModel: 'custom-summarizer',
          agentModel: 'custom-agent',
          browserModel: 'custom-browser',
        },
      })
    )

    const models = await getEffectiveModels()

    expect(models).toEqual({
      summarizerModel: 'custom-summarizer',
      agentModel: 'custom-agent',
      browserModel: 'custom-browser',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    })
  })

  it('uses defaults for unset model fields', async () => {
    await storeSettings(
      JSON.stringify({
        models: { agentModel: 'custom-agent' },
      })
    )

    const models = await getEffectiveModels()

    expect(models.agentModel).toBe('custom-agent')
    expect(models.summarizerModel).toBe('haiku')
    expect(models.browserModel).toBe('haiku')
  })

  it('falls back to defaults when model values are empty strings', async () => {
    await storeSettings(
      JSON.stringify({
        models: {
          summarizerModel: '',
          agentModel: '',
          browserModel: '',
        },
      })
    )

    const models = await getEffectiveModels()

    // Empty strings are falsy, so || fallback triggers
    expect(models.summarizerModel).toBe('haiku')
    expect(models.agentModel).toBe('opus')
    expect(models.browserModel).toBe('haiku')
  })

  it('handles models being undefined in settings', async () => {
    await storeSettings(JSON.stringify({}))

    const models = await getEffectiveModels()

    expect(models).toEqual({
      summarizerModel: 'haiku',
      agentModel: 'opus',
      browserModel: 'haiku',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    })
  })

  it('uses the selected provider catalog defaults when model fields are missing', async () => {
    await storeSettings(JSON.stringify({ llmProvider: 'platform' }))

    expect(await getEffectiveModels()).toEqual({
      summarizerModel: 'haiku',
      agentModel: 'sonnet',
      browserModel: 'haiku',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    })
  })

  it('falls back to Anthropic defaults for an unknown persisted provider', async () => {
    // A downgrade can load a provider id written by a newer app version. The
    // stored settings are not schema-validated, so this must remain a soft fallback.
    await storeSettings(JSON.stringify({ llmProvider: 'some-future-provider' }))

    expect(await getEffectiveModels()).toEqual({
      summarizerModel: 'haiku',
      agentModel: 'opus',
      browserModel: 'haiku',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    })
  })
})

// ============================================================================
// getEffectiveAgentLimits()
// ============================================================================

describe('getEffectiveAgentLimits', () => {
  it('returns empty object when no limits configured', async () => {
    expect(await getEffectiveAgentLimits()).toEqual({})
  })

  it('returns configured limits', async () => {
    await storeSettings(
      JSON.stringify({
        agentLimits: { maxTurns: 25, maxBudgetUsd: 10 },
      })
    )

    expect(await getEffectiveAgentLimits()).toEqual({ maxTurns: 25, maxBudgetUsd: 10 })
  })

  it('returns full limits when all fields are set', async () => {
    const limits = {
      maxOutputTokens: 4096,
      maxThinkingTokens: 2048,
      maxTurns: 50,
      maxBudgetUsd: 20,
    }
    await storeSettings(JSON.stringify({ agentLimits: limits }))

    expect(await getEffectiveAgentLimits()).toEqual(limits)
  })
})

// ============================================================================
// getCustomEnvVars()
// ============================================================================

describe('getCustomEnvVars', () => {
  it('returns empty object when no custom env vars configured', async () => {
    expect(await getCustomEnvVars()).toEqual({})
  })

  it('returns configured env vars', async () => {
    const envVars = { FOO: 'bar', BAZ: 'qux' }
    await storeSettings(JSON.stringify({ customEnvVars: envVars }))

    expect(await getCustomEnvVars()).toEqual(envVars)
  })

  it('returns empty object when customEnvVars is null', async () => {
    await storeSettings(JSON.stringify({ customEnvVars: null }))

    expect(await getCustomEnvVars()).toEqual({})
  })
})

// ============================================================================
// getModelCatalogSettings()
// ============================================================================

describe('getModelCatalogSettings', () => {
  it('returns empty overrides when no model catalog is configured', async () => {
    expect(await getModelCatalogSettings()).toEqual({})
  })

  it('returns configured model catalog overrides', async () => {
    const modelCatalog = {
      platform: {
        overrides: [{ id: 'gpt-5.5', pricing: { inputPerMtok: 6, outputPerMtok: 36 } }],
      },
    }
    await storeSettings(JSON.stringify({ modelCatalog }))

    expect(await getModelCatalogSettings()).toEqual(modelCatalog)
  })

  it('returns empty overrides when modelCatalog is null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await storeSettings(JSON.stringify({ modelCatalog: null }))

    expect(await getModelCatalogSettings()).toEqual({})
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

// ============================================================================
// DEFAULT_SETTINGS export
// ============================================================================

describe('DEFAULT_SETTINGS', () => {
  it('has expected container defaults', () => {
    expect(DEFAULT_SETTINGS.container.containerRunner).toBe(process.platform === 'darwin' ? 'lima' : 'docker')
    expect(DEFAULT_SETTINGS.container.agentImage).toBe(
      'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
    )
    expect(DEFAULT_SETTINGS.container.resourceLimits).toEqual({ cpu: 2, memory: '4g' })
  })

  it('has expected app defaults', () => {
    expect(DEFAULT_SETTINGS.app?.showMenuBarIcon).toBe(true)
    expect(DEFAULT_SETTINGS.app?.autoSleepTimeoutMinutes).toBe(30)
    expect(DEFAULT_SETTINGS.app?.warmStartOnType).toBe(true)
    expect(DEFAULT_SETTINGS.app?.autoResumeOnUnexpectedDeath).toBe(true)
    expect(DEFAULT_SETTINGS.app?.apiLogAutoDeleteDays).toBe(30)
    expect(isAutoResumeOnUnexpectedDeathEnabled(undefined)).toBe(true)
    expect(isAutoResumeOnUnexpectedDeathEnabled({ app: {} })).toBe(true)
    expect(isAutoResumeOnUnexpectedDeathEnabled({ app: { autoResumeOnUnexpectedDeath: false } })).toBe(false)
  })

  it('has expected notification defaults', () => {
    expect(DEFAULT_SETTINGS.app?.notifications).toEqual({
      enabled: true,
      sessionComplete: true,
      sessionWaiting: true,
      sessionScheduled: true,
    })
  })

  it('has expected model defaults (bare aliases so fresh installs track latest)', () => {
    expect(DEFAULT_SETTINGS.models).toEqual({
      summarizerModel: 'haiku',
      agentModel: 'opus',
      browserModel: 'haiku',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
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
      mobileDeviceLifetimeDays: 90,
      accountLockoutThreshold: 10,
      accountLockoutDurationMin: 30,
    })
  })
})

// ============================================================================
// Integration-style scenarios
// ============================================================================

describe('integration scenarios', () => {
  it('full settings round-trip: load defaults, customize, save, reload', async () => {
    // 1. Start with nothing stored
    const defaults = await getSettings()
    expect(defaults).toEqual(DEFAULT_SETTINGS)

    // 2-3. Customize some values and save
    await mutateSettings((s) => {
      s.container.containerRunner = 'podman'
      s.container.resourceLimits = { cpu: 8, memory: '16g' }
      s.apiKeys = { anthropicApiKey: 'sk-test-123' }
    })

    // 4. Reload from the database
    const reloaded = await getSettings()
    expect(reloaded.container.containerRunner).toBe('podman')
    expect(reloaded.container.resourceLimits).toEqual({ cpu: 8, memory: '16g' })
    expect(reloaded.apiKeys?.anthropicApiKey).toBe('sk-test-123')
  })

  it('every getSettings-dependent function reads the database itself', async () => {
    await storeSettings(
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
    const reads = vi.spyOn(records, 'readStoredRecord')

    expect(await getAnthropicApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
    expect(await getEffectiveAnthropicApiKey()).toBe('sk-test')
    expect(await getComposioApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
    expect(await getEffectiveComposioApiKey()).toBe('ck-test')
    expect(await getComposioUserId()).toBe('uid-test')
    expect((await getEffectiveModels()).agentModel).toBe('custom-model')
    expect(await getEffectiveAgentLimits()).toEqual({ maxTurns: 10 })
    expect(await getCustomEnvVars()).toEqual({ MY_VAR: 'hello' })

    // No process cache: one database read per call.
    expect(reads).toHaveBeenCalledTimes(8)
  })

  it('a mutateSettings write is what the getters return next', async () => {
    // Initial read: defaults
    expect(await getEffectiveAnthropicApiKey()).toBeUndefined()
    expect((await getEffectiveModels()).agentModel).toBe('opus')

    await mutateSettings((s) => {
      s.apiKeys = { anthropicApiKey: 'sk-updated' }
      s.models = { ...s.models!, agentModel: 'custom-agent' }
    })

    expect(await getEffectiveAnthropicApiKey()).toBe('sk-updated')
    expect((await getEffectiveModels()).agentModel).toBe('custom-agent')
  })
})

// ============================================================================
// runtimeSettings initialization
// ============================================================================

describe('runtimeSettings migration', () => {

  it('initializes runtimeSettings as empty object for old stored settings', async () => {
    await storeSettings(
      JSON.stringify({
        container: {
          containerRunner: 'docker',
        },
      })
    )

    const result = await getSettings()

    expect(result.container.runtimeSettings).toEqual({})
  })

  it('preserves existing runtimeSettings when present', async () => {
    await storeSettings(
      JSON.stringify({
        container: {
          containerRunner: 'lima',
          runtimeSettings: {
            lima: { vmMemory: '8GiB' },
          },
        },
      })
    )

    const result = await getSettings()

    expect(result.container.runtimeSettings).toEqual({
      lima: { vmMemory: '8GiB' },
    })
  })

  it('initializes runtimeSettings when container field is missing entirely', async () => {
    await storeSettings(JSON.stringify({}))

    const result = await getSettings()

    expect(result.container.runtimeSettings).toEqual({})
  })

  it('round-trips runtimeSettings through save and reload', async () => {
    await mutateSettings((s) => {
      s.container.runtimeSettings = {
        lima: { vmMemory: '16GiB' },
      }
    })

    expect((await storedSettings()).container.runtimeSettings).toEqual({ lima: { vmMemory: '16GiB' } })
    const reloaded = await getSettings()
    expect(reloaded.container.runtimeSettings?.lima?.vmMemory).toBe('16GiB')
  })
})

// ============================================================================
// agentCapabilities (subagent/workflow launch policies)
// ============================================================================

describe('agentCapabilities', () => {
  it('defaults to allow subagents / review workflows when nothing is stored', async () => {
    expect((await getSettings()).agentCapabilities).toEqual({ subagents: 'allow', workflows: 'review' })
  })

  it('fills a partial stored section from the defaults', async () => {
    await storeSettings(JSON.stringify({ agentCapabilities: { subagents: 'block' } }))
    expect((await getSettings()).agentCapabilities).toEqual({ subagents: 'block', workflows: 'review' })
  })

  it('preserves a fully customized section', async () => {
    await storeSettings(JSON.stringify({ agentCapabilities: { subagents: 'review', workflows: 'allow' } }))
    expect((await getSettings()).agentCapabilities).toEqual({ subagents: 'review', workflows: 'allow' })
  })

  it('defaults only the invalid field, keeping valid siblings', async () => {
    await storeSettings(JSON.stringify({ agentCapabilities: { subagents: 'maybe', workflows: 'allow' } }))
    expect((await getSettings()).agentCapabilities).toEqual({ subagents: 'allow', workflows: 'allow' })
  })

  it('an invalid field never lifts a valid block on the other capability', async () => {
    await storeSettings(JSON.stringify({ agentCapabilities: { subagents: 'block', workflows: 'future-tier' } }))
    expect((await getSettings()).agentCapabilities).toEqual({ subagents: 'block', workflows: 'review' })
  })

  it('DEFAULT_SETTINGS carries the section so new installs persist it', () => {
    expect(DEFAULT_SETTINGS.agentCapabilities).toEqual({ subagents: 'allow', workflows: 'review' })
  })
})

describe('globalInstructions', () => {
  it('is absent when never set', async () => {
    expect((await getSettings()).globalInstructions).toBeUndefined()
  })

  it('loads a stored string as-is', async () => {
    await storeSettings(JSON.stringify({ globalInstructions: 'Be concise.\n' }))
    expect((await getSettings()).globalInstructions).toBe('Be concise.\n')
  })

  it.each([42, { text: 'x' }, 'x'.repeat(20_001)])('drops an invalid stored value (%#) instead of prompting every agent with it', async (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await storeSettings(JSON.stringify({ globalInstructions: value }))
    expect((await getSettings()).globalInstructions).toBeUndefined()
    warn.mockRestore()
  })
})
