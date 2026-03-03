import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGetSettings = vi.fn()
const mockUpdateSettings = vi.fn()
const mockClearSettingsCache = vi.fn()
const mockGetAnthropicApiKeyStatus = vi.fn()
const mockGetComposioApiKeyStatus = vi.fn()
const mockGetComposioUserId = vi.fn()
const mockGetEffectiveModels = vi.fn()
const mockGetEffectiveAgentLimits = vi.fn()
const mockGetCustomEnvVars = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  clearSettingsCache: (...args: unknown[]) => mockClearSettingsCache(...args),
  getAnthropicApiKeyStatus: (...args: unknown[]) => mockGetAnthropicApiKeyStatus(...args),
  getComposioApiKeyStatus: (...args: unknown[]) => mockGetComposioApiKeyStatus(...args),
  getComposioUserId: (...args: unknown[]) => mockGetComposioUserId(...args),
  getEffectiveModels: (...args: unknown[]) => mockGetEffectiveModels(...args),
  getEffectiveAgentLimits: (...args: unknown[]) => mockGetEffectiveAgentLimits(...args),
  getCustomEnvVars: (...args: unknown[]) => mockGetCustomEnvVars(...args),
}))

const mockHasRunningAgents = vi.fn()
const mockGetRunningAgentIds = vi.fn()
const mockClearClients = vi.fn()
const mockEnsureImageReady = vi.fn()
const mockGetReadiness = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    hasRunningAgents: (...args: unknown[]) => mockHasRunningAgents(...args),
    getRunningAgentIds: (...args: unknown[]) => mockGetRunningAgentIds(...args),
    clearClients: (...args: unknown[]) => mockClearClients(...args),
    ensureImageReady: (...args: unknown[]) => mockEnsureImageReady(...args),
    getReadiness: (...args: unknown[]) => mockGetReadiness(...args),
    stopAll: vi.fn(),
  },
}))

const mockCheckAllRunnersAvailability = vi.fn()
const mockRefreshRunnerAvailability = vi.fn()
const mockStartRunner = vi.fn()

vi.mock('@shared/lib/container/client-factory', () => ({
  checkAllRunnersAvailability: (...args: unknown[]) => mockCheckAllRunnersAvailability(...args),
  refreshRunnerAvailability: (...args: unknown[]) => mockRefreshRunnerAvailability(...args),
  startRunner: (...args: unknown[]) => mockStartRunner(...args),
  SUPPORTED_RUNNERS: ['docker', 'podman'],
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => '/mock/data',
  getAgentsDataDir: () => '/mock/data/agents',
}))

vi.mock('../../main/host-browser', () => ({
  detectAllProviders: () => [],
}))

// Auth middleware: no-op in tests (non-auth mode)
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => false,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

vi.mock('@shared/lib/db', () => ({
  db: { delete: () => ({ run: vi.fn() }) },
}))

vi.mock('@shared/lib/db/schema', () => ({
  proxyAuditLog: {},
  proxyTokens: {},
  agentConnectedAccounts: {},
  scheduledTasks: {},
  notifications: {},
  connectedAccounts: {},
}))

vi.mock('fs', () => ({
  default: { promises: { rm: vi.fn().mockResolvedValue(undefined) } },
}))

vi.mock('path', () => ({
  default: { join: (...args: string[]) => args.join('/') },
}))

import settings from './settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono()
  app.route('/api/settings', settings)
  return app
}

function defaultSettings() {
  return {
    container: {
      containerRunner: 'docker',
      agentImage: 'superagent:latest',
      resourceLimits: { cpu: 2, memory: '4g' },
    },
    app: { showMenuBarIcon: true },
    apiKeys: { anthropicApiKey: 'sk-existing' },
    models: { summarizerModel: 'claude-3-haiku', agentModel: 'claude-sonnet-4-20250514', browserModel: 'claude-3-haiku' },
    agentLimits: { maxTurns: 100 },
    customEnvVars: { FOO: 'bar' },
    skillsets: [],
    auth: { signupMode: 'open' as const },
  }
}

function setupDefaults() {
  mockGetSettings.mockReturnValue(defaultSettings())
  mockHasRunningAgents.mockReturnValue(false)
  mockGetRunningAgentIds.mockResolvedValue([])
  mockCheckAllRunnersAvailability.mockResolvedValue([])
  mockGetAnthropicApiKeyStatus.mockReturnValue({ isConfigured: true, source: 'settings' })
  mockGetComposioApiKeyStatus.mockReturnValue({ isConfigured: false, source: 'none' })
  mockGetComposioUserId.mockReturnValue(undefined)
  mockGetEffectiveModels.mockReturnValue({ summarizerModel: 'claude-3-haiku', agentModel: 'claude-sonnet-4-20250514', browserModel: 'claude-3-haiku' })
  mockGetEffectiveAgentLimits.mockReturnValue({ maxTurns: 100 })
  mockGetCustomEnvVars.mockReturnValue({ FOO: 'bar' })
  mockGetReadiness.mockReturnValue({ ready: true })
  mockEnsureImageReady.mockResolvedValue(undefined)
  mockClearClients.mockReturnValue(undefined)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings route', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaults()
    app = createApp()
  })

  async function putSettings(body: Record<string, unknown>): Promise<Response> {
    return app.request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  // =========================================================================
  // Deep merging of container.resourceLimits
  // =========================================================================
  describe('deep merging of container.resourceLimits', () => {
    it('merges partial resourceLimits with existing values', async () => {
      const res = await putSettings({
        container: { resourceLimits: { cpu: 4 } },
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()

      const saved = mockUpdateSettings.mock.calls[0][0]
      // cpu was overridden, memory preserved from original
      expect(saved.container.resourceLimits).toEqual({ cpu: 4, memory: '4g' })
    })

    it('merges partial memory only, preserving cpu', async () => {
      const res = await putSettings({
        container: { resourceLimits: { memory: '8g' } },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.container.resourceLimits).toEqual({ cpu: 2, memory: '8g' })
    })

    it('preserves existing resourceLimits when not provided in body', async () => {
      const res = await putSettings({
        container: { agentImage: 'new-image:v2' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      // resourceLimits unchanged
      expect(saved.container.resourceLimits).toEqual({ cpu: 2, memory: '4g' })
      // agentImage updated
      expect(saved.container.agentImage).toBe('new-image:v2')
    })

    it('completely replaces resourceLimits when both fields provided', async () => {
      const res = await putSettings({
        container: { resourceLimits: { cpu: 8, memory: '16g' } },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.container.resourceLimits).toEqual({ cpu: 8, memory: '16g' })
    })
  })

  // =========================================================================
  // API key handling
  // =========================================================================
  describe('API key handling', () => {
    it('sets a new Anthropic API key when non-empty string provided', async () => {
      const res = await putSettings({
        apiKeys: { anthropicApiKey: 'sk-new-key' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.anthropicApiKey).toBe('sk-new-key')
    })

    it('deletes Anthropic API key when empty string provided', async () => {
      // Default settings only have anthropicApiKey, so deleting it empties apiKeys
      // and the cleanup logic removes the entire apiKeys object
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', composioApiKey: 'comp-key' },
      })

      const res = await putSettings({
        apiKeys: { anthropicApiKey: '' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.anthropicApiKey).toBeUndefined()
      // composioApiKey should remain
      expect(saved.apiKeys.composioApiKey).toBe('comp-key')
    })

    it('keeps existing Anthropic API key when apiKeys.anthropicApiKey not provided', async () => {
      const res = await putSettings({
        apiKeys: { composioApiKey: 'new-composio-key' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      // anthropicApiKey preserved from existing settings
      expect(saved.apiKeys.anthropicApiKey).toBe('sk-existing')
      // composioApiKey set
      expect(saved.apiKeys.composioApiKey).toBe('new-composio-key')
    })

    it('sets Composio API key when non-empty', async () => {
      const res = await putSettings({
        apiKeys: { composioApiKey: 'comp-key' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.composioApiKey).toBe('comp-key')
    })

    it('deletes Composio API key when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', composioApiKey: 'old-comp' },
      })

      const res = await putSettings({
        apiKeys: { composioApiKey: '' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.composioApiKey).toBeUndefined()
    })

    it('sets Browserbase API key and project ID', async () => {
      const res = await putSettings({
        apiKeys: { browserbaseApiKey: 'bb-key', browserbaseProjectId: 'bb-proj' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.browserbaseApiKey).toBe('bb-key')
      expect(saved.apiKeys.browserbaseProjectId).toBe('bb-proj')
    })

    it('deletes Browserbase API key when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', browserbaseApiKey: 'old-bb' },
      })

      const res = await putSettings({
        apiKeys: { browserbaseApiKey: '' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.browserbaseApiKey).toBeUndefined()
    })

    it('removes apiKeys entirely when all keys deleted and object becomes empty', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'only-key' },
      })

      const res = await putSettings({
        apiKeys: { anthropicApiKey: '' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys).toBeUndefined()
    })

    it('does not modify apiKeys when body.apiKeys is undefined', async () => {
      const res = await putSettings({
        app: { showMenuBarIcon: false },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      // apiKeys preserved as-is from current settings
      expect(saved.apiKeys).toEqual({ anthropicApiKey: 'sk-existing' })
    })
  })

  // =========================================================================
  // Running agents guard
  // =========================================================================
  describe('cannot change runner while agents running', () => {
    it('returns 409 when changing containerRunner while agents are running', async () => {
      mockHasRunningAgents.mockReturnValue(true)
      mockGetRunningAgentIds.mockResolvedValue(['agent-1', 'agent-2'])

      const res = await putSettings({
        container: { containerRunner: 'podman' },
      })

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toContain('Cannot change container runner')
      expect(body.runningAgents).toEqual(['agent-1', 'agent-2'])
      // updateSettings should NOT have been called
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('returns 409 when changing resourceLimits while agents are running', async () => {
      mockHasRunningAgents.mockReturnValue(true)
      mockGetRunningAgentIds.mockResolvedValue(['agent-1'])

      const res = await putSettings({
        container: { resourceLimits: { cpu: 8, memory: '16g' } },
      })

      expect(res.status).toBe(409)
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('allows changing containerRunner when no agents are running', async () => {
      mockHasRunningAgents.mockReturnValue(false)

      const res = await putSettings({
        container: { containerRunner: 'podman' },
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
    })

    it('allows changing same containerRunner value while agents running', async () => {
      mockHasRunningAgents.mockReturnValue(true)

      // Setting the same value as current should be allowed
      const res = await putSettings({
        container: { containerRunner: 'docker' },
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
    })

    it('allows changing non-restricted settings while agents are running', async () => {
      mockHasRunningAgents.mockReturnValue(true)

      const res = await putSettings({
        container: { agentImage: 'new-image:v2' },
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
    })
  })

  // =========================================================================
  // Post-update side effects
  // =========================================================================
  describe('post-update side effects', () => {
    it('clears container clients when runner changes', async () => {
      const res = await putSettings({
        container: { containerRunner: 'podman' },
      })

      expect(res.status).toBe(200)
      expect(mockClearClients).toHaveBeenCalledOnce()
    })

    it('does not clear container clients when runner stays the same', async () => {
      const res = await putSettings({
        container: { agentImage: 'new-image:v2' },
      })

      expect(res.status).toBe(200)
      expect(mockClearClients).not.toHaveBeenCalled()
    })

    it('calls ensureImageReady when agentImage changes', async () => {
      const res = await putSettings({
        container: { agentImage: 'new-image:v2' },
      })

      expect(res.status).toBe(200)
      expect(mockEnsureImageReady).toHaveBeenCalledOnce()
    })

    it('calls ensureImageReady when containerRunner changes', async () => {
      const res = await putSettings({
        container: { containerRunner: 'podman' },
      })

      expect(res.status).toBe(200)
      expect(mockEnsureImageReady).toHaveBeenCalledOnce()
    })

    it('does not call ensureImageReady when neither image nor runner changes', async () => {
      const res = await putSettings({
        app: { showMenuBarIcon: false },
      })

      expect(res.status).toBe(200)
      expect(mockEnsureImageReady).not.toHaveBeenCalled()
    })

    it('calls updateSettings with fully merged settings', async () => {
      const res = await putSettings({
        container: { agentImage: 'custom:v3' },
        app: { showMenuBarIcon: false },
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()

      const saved = mockUpdateSettings.mock.calls[0][0]
      // container fields merged
      expect(saved.container.containerRunner).toBe('docker')
      expect(saved.container.agentImage).toBe('custom:v3')
      // app fields merged
      expect(saved.app.showMenuBarIcon).toBe(false)
      // skillsets preserved
      expect(saved.skillsets).toEqual([])
    })

    it('calls checkAllRunnersAvailability after update', async () => {
      await putSettings({ app: { showMenuBarIcon: false } })

      expect(mockCheckAllRunnersAvailability).toHaveBeenCalledOnce()
    })
  })

  // =========================================================================
  // Models and agentLimits merging
  // =========================================================================
  describe('models and agentLimits merging', () => {
    it('merges partial models with existing', async () => {
      const res = await putSettings({
        models: { agentModel: 'claude-opus-4-20250514' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.models.agentModel).toBe('claude-opus-4-20250514')
      expect(saved.models.summarizerModel).toBe('claude-3-haiku')
    })

    it('preserves existing models when not provided', async () => {
      const res = await putSettings({
        app: { showMenuBarIcon: false },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.models).toEqual({ summarizerModel: 'claude-3-haiku', agentModel: 'claude-sonnet-4-20250514', browserModel: 'claude-3-haiku' })
    })

    it('merges partial agentLimits with existing', async () => {
      const res = await putSettings({
        agentLimits: { maxBudgetUsd: 50 },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.agentLimits.maxBudgetUsd).toBe(50)
      expect(saved.agentLimits.maxTurns).toBe(100)
    })

    it('replaces customEnvVars entirely when provided', async () => {
      const res = await putSettings({
        customEnvVars: { NEW_VAR: 'value' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      // customEnvVars replaced, not merged
      expect(saved.customEnvVars).toEqual({ NEW_VAR: 'value' })
    })

    it('merges auth settings with existing', async () => {
      const res = await putSettings({
        auth: { signupMode: 'closed' as const },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.auth.signupMode).toBe('closed')
    })
  })
})
