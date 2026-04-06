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
const mockGetVoiceSettings = vi.fn()
const mockGetBrowserbaseApiKeyStatus = vi.fn()

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
  getVoiceSettings: (...args: unknown[]) => mockGetVoiceSettings(...args),
  getBrowserbaseApiKeyStatus: (...args: unknown[]) => mockGetBrowserbaseApiKeyStatus(...args),
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

const mockSttGetApiKeyStatus = vi.fn()
const mockSttValidateKey = vi.fn()

vi.mock('@shared/lib/stt', () => ({
  getSttProvider: (id: string) => ({
    getApiKeyStatus: () => mockSttGetApiKeyStatus(id),
    validateKey: (...args: unknown[]) => mockSttValidateKey(id, ...args),
  }),
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

vi.mock('@shared/lib/analytics/tenant-id', () => ({
  getTenantId: () => 'mock-tenant-id',
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
    platformAuth: {
      token: 'plat_sa_testtoken',
      tokenPreview: 'plat_s...oken',
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
      orgName: 'Test Org',
      role: 'owner',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
  }
}

function setupDefaults() {
  mockGetSettings.mockReturnValue(defaultSettings())
  mockHasRunningAgents.mockReturnValue(false)
  mockGetRunningAgentIds.mockResolvedValue([])
  mockCheckAllRunnersAvailability.mockResolvedValue([])
  mockGetAnthropicApiKeyStatus.mockReturnValue({ isConfigured: true, source: 'settings' })
  mockGetComposioApiKeyStatus.mockReturnValue({ isConfigured: false, source: 'none' })
  mockGetBrowserbaseApiKeyStatus.mockReturnValue({ isConfigured: false, source: 'none' })
  mockGetComposioUserId.mockReturnValue(undefined)
  mockGetEffectiveModels.mockReturnValue({ summarizerModel: 'claude-3-haiku', agentModel: 'claude-sonnet-4-20250514', browserModel: 'claude-3-haiku' })
  mockGetEffectiveAgentLimits.mockReturnValue({ maxTurns: 100 })
  mockGetCustomEnvVars.mockReturnValue({ FOO: 'bar' })
  mockSttGetApiKeyStatus.mockImplementation((id: string) => {
    if (id === 'deepgram') return { isConfigured: false, source: 'none' }
    if (id === 'openai') return { isConfigured: false, source: 'none' }
    return { isConfigured: false, source: 'none' }
  })
  mockSttValidateKey.mockResolvedValue({ valid: true })
  mockGetVoiceSettings.mockReturnValue({})
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

  describe('platform auth persistence', () => {
    it('preserves platformAuth when updating unrelated settings', async () => {
      const res = await putSettings({
        llmProvider: 'platform',
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()

      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.platformAuth).toEqual(defaultSettings().platformAuth)
      expect(saved.llmProvider).toBe('platform')
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

    it('merges voice settings with existing', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        voice: { sttProvider: 'deepgram' },
      })

      const res = await putSettings({
        voice: { sttProvider: 'openai' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.voice.sttProvider).toBe('openai')
    })

    it('preserves voice settings when not provided', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        voice: { sttProvider: 'deepgram' },
      })

      const res = await putSettings({
        app: { showMenuBarIcon: false },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.voice).toEqual({ sttProvider: 'deepgram' })
    })
  })

  // =========================================================================
  // STT key validation
  // =========================================================================
  describe('POST /validate-stt-key', () => {
    async function validateSttKey(body: Record<string, unknown>): Promise<Response> {
      return app.request('http://localhost/api/settings/validate-stt-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('returns 400 when apiKey is missing', async () => {
      const res = await validateSttKey({ provider: 'deepgram' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('API key is required')
    })

    it('returns 400 when provider is missing', async () => {
      const res = await validateSttKey({ apiKey: 'test-key' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid provider')
    })

    it('returns 400 when provider is invalid', async () => {
      const res = await validateSttKey({ provider: 'foobar', apiKey: 'test-key' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid provider')
    })

    it('returns valid: true for a valid deepgram key', async () => {
      mockSttValidateKey.mockResolvedValue({ valid: true })

      const res = await validateSttKey({ provider: 'deepgram', apiKey: 'dg-test-key' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(true)
      expect(mockSttValidateKey).toHaveBeenCalledWith('deepgram', 'dg-test-key')
    })

    it('returns valid: true for a valid openai key', async () => {
      mockSttValidateKey.mockResolvedValue({ valid: true })

      const res = await validateSttKey({ provider: 'openai', apiKey: 'sk-test-key' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(true)
      expect(mockSttValidateKey).toHaveBeenCalledWith('openai', 'sk-test-key')
    })

    it('returns valid: false with error for an invalid key', async () => {
      mockSttValidateKey.mockResolvedValue({ valid: false, error: 'Invalid API key' })

      const res = await validateSttKey({ provider: 'deepgram', apiKey: 'bad-key' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(false)
      expect(body.error).toBe('Invalid API key')
    })

    it('handles validateKey throwing an error', async () => {
      mockSttValidateKey.mockRejectedValue(new Error('Network timeout'))

      const res = await validateSttKey({ provider: 'openai', apiKey: 'test-key' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(false)
      expect(body.error).toBe('Network timeout')
    })
  })

  // =========================================================================
  // GET settings includes per-provider STT key status
  // =========================================================================
  describe('GET settings STT key status', () => {
    it('calls getSttProvider with correct provider ids', async () => {
      mockSttGetApiKeyStatus.mockImplementation((id: string) => {
        if (id === 'deepgram') return { isConfigured: true, source: 'settings' }
        if (id === 'openai') return { isConfigured: false, source: 'none' }
        return { isConfigured: false, source: 'none' }
      })

      const res = await app.request('http://localhost/api/settings')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.apiKeyStatus.deepgram).toEqual({ isConfigured: true, source: 'settings' })
      expect(body.apiKeyStatus.openai).toEqual({ isConfigured: false, source: 'none' })
    })
  })

  // =========================================================================
  // API key handling — all key types
  // =========================================================================
  describe('API key handling — all key types', () => {
    it('sets OpenRouter API key when non-empty', async () => {
      const res = await putSettings({ apiKeys: { openrouterApiKey: 'or-key' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.openrouterApiKey).toBe('or-key')
      // existing key preserved
      expect(saved.apiKeys.anthropicApiKey).toBe('sk-existing')
    })

    it('deletes OpenRouter API key when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', openrouterApiKey: 'or-old' },
      })
      const res = await putSettings({ apiKeys: { openrouterApiKey: '' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.openrouterApiKey).toBeUndefined()
      expect(saved.apiKeys.anthropicApiKey).toBe('sk-existing')
    })

    it('sets all Bedrock credential fields', async () => {
      const res = await putSettings({
        apiKeys: {
          bedrockApiKey: 'brk-key',
          bedrockAccessKeyId: 'AKIA123',
          bedrockSecretAccessKey: 'secret123',
          bedrockRegion: 'us-west-2',
        },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.bedrockApiKey).toBe('brk-key')
      expect(saved.apiKeys.bedrockAccessKeyId).toBe('AKIA123')
      expect(saved.apiKeys.bedrockSecretAccessKey).toBe('secret123')
      expect(saved.apiKeys.bedrockRegion).toBe('us-west-2')
    })

    it('deletes individual Bedrock credential fields', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: {
          anthropicApiKey: 'sk-existing',
          bedrockAccessKeyId: 'AKIA123',
          bedrockSecretAccessKey: 'secret123',
          bedrockRegion: 'us-west-2',
        },
      })
      const res = await putSettings({
        apiKeys: { bedrockAccessKeyId: '', bedrockRegion: '' },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.bedrockAccessKeyId).toBeUndefined()
      expect(saved.apiKeys.bedrockRegion).toBeUndefined()
      // untouched fields preserved
      expect(saved.apiKeys.bedrockSecretAccessKey).toBe('secret123')
      expect(saved.apiKeys.anthropicApiKey).toBe('sk-existing')
    })

    it('sets Composio User ID when non-empty', async () => {
      const res = await putSettings({ apiKeys: { composioUserId: 'user-123' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.composioUserId).toBe('user-123')
    })

    it('deletes Composio User ID when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', composioUserId: 'old-user' },
      })
      const res = await putSettings({ apiKeys: { composioUserId: '' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.composioUserId).toBeUndefined()
    })

    it('deletes Browserbase Project ID when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', browserbaseProjectId: 'old-proj' },
      })
      const res = await putSettings({ apiKeys: { browserbaseProjectId: '' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.browserbaseProjectId).toBeUndefined()
    })

    it('sets Deepgram API key when non-empty', async () => {
      const res = await putSettings({ apiKeys: { deepgramApiKey: 'dg-key' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.deepgramApiKey).toBe('dg-key')
    })

    it('deletes Deepgram API key when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', deepgramApiKey: 'dg-old' },
      })
      const res = await putSettings({ apiKeys: { deepgramApiKey: '' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.deepgramApiKey).toBeUndefined()
    })

    it('sets OpenAI API key when non-empty', async () => {
      const res = await putSettings({ apiKeys: { openaiApiKey: 'sk-openai' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.openaiApiKey).toBe('sk-openai')
    })

    it('deletes OpenAI API key when empty string', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', openaiApiKey: 'sk-openai-old' },
      })
      const res = await putSettings({ apiKeys: { openaiApiKey: '' } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.openaiApiKey).toBeUndefined()
    })

    it('sets and deletes multiple keys in one request', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-existing', openrouterApiKey: 'or-old' },
      })
      const res = await putSettings({
        apiKeys: {
          anthropicApiKey: 'sk-new',
          openrouterApiKey: '',
          composioApiKey: 'comp-new',
          deepgramApiKey: 'dg-new',
        },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys.anthropicApiKey).toBe('sk-new')
      expect(saved.apiKeys.openrouterApiKey).toBeUndefined()
      expect(saved.apiKeys.composioApiKey).toBe('comp-new')
      expect(saved.apiKeys.deepgramApiKey).toBe('dg-new')
    })

    it('removes apiKeys entirely when all keys are deleted at once', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { anthropicApiKey: 'sk-old', openrouterApiKey: 'or-old' },
      })
      const res = await putSettings({
        apiKeys: { anthropicApiKey: '', openrouterApiKey: '' },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys).toBeUndefined()
    })

    it('leaves apiKeys unchanged when apiKeys key absent but not undefined', async () => {
      // sending body without apiKeys field at all
      const res = await putSettings({ llmProvider: 'openrouter' })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.apiKeys).toEqual({ anthropicApiKey: 'sk-existing' })
    })
  })

  // =========================================================================
  // Lima VM memory validation
  // =========================================================================
  describe('Lima VM memory validation', () => {
    it('returns 400 for invalid VM memory value', async () => {
      const res = await putSettings({
        container: {
          runtimeSettings: { lima: { vmMemory: '3GiB' } },
        },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid VM memory')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('accepts valid VM memory values', async () => {
      for (const validMemory of ['2GiB', '4GiB', '8GiB', '16GiB']) {
        vi.clearAllMocks()
        setupDefaults()
        app = createApp()

        const res = await putSettings({
          container: {
            runtimeSettings: { lima: { vmMemory: validMemory } },
          },
        })
        expect(res.status).toBe(200)
        expect(mockUpdateSettings).toHaveBeenCalledOnce()
      }
    })

    it('allows runtimeSettings without lima vmMemory', async () => {
      const res = await putSettings({
        container: {
          runtimeSettings: { lima: { somethingElse: 'value' } },
        },
      })
      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
    })
  })

  // =========================================================================
  // Settings merge — hostBrowserProvider null handling
  // =========================================================================
  describe('hostBrowserProvider null handling', () => {
    it('removes hostBrowserProvider when explicitly set to null', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        app: { showMenuBarIcon: true, hostBrowserProvider: 'chrome' },
      })
      const res = await putSettings({
        app: { hostBrowserProvider: null },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.hostBrowserProvider).toBeUndefined()
    })

    it('sets hostBrowserProvider when given a valid value', async () => {
      const res = await putSettings({
        app: { hostBrowserProvider: 'browserbase' },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.hostBrowserProvider).toBe('browserbase')
    })

    it('preserves hostBrowserProvider when app is updated but hostBrowserProvider not mentioned', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        app: { showMenuBarIcon: true, hostBrowserProvider: 'chrome' },
      })
      const res = await putSettings({
        app: { showMenuBarIcon: false },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.hostBrowserProvider).toBe('chrome')
      expect(saved.app.showMenuBarIcon).toBe(false)
    })
  })

  // =========================================================================
  // Settings merge — llmProvider
  // =========================================================================
  describe('llmProvider handling', () => {
    it('updates llmProvider when provided', async () => {
      const res = await putSettings({ llmProvider: 'openrouter' })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.llmProvider).toBe('openrouter')
    })

    it('preserves llmProvider when not provided', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        llmProvider: 'bedrock',
      })
      const res = await putSettings({ app: { showMenuBarIcon: false } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.llmProvider).toBe('bedrock')
    })

    it('allows setting llmProvider to undefined explicitly', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        llmProvider: 'openrouter',
      })
      // When body.llmProvider is undefined (key not present), existing value preserved
      const res = await putSettings({ app: { showMenuBarIcon: true } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.llmProvider).toBe('openrouter')
    })
  })

  // =========================================================================
  // Settings merge — shareAnalytics
  // =========================================================================
  describe('shareAnalytics handling', () => {
    it('updates shareAnalytics when provided', async () => {
      const res = await putSettings({ shareAnalytics: true })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.shareAnalytics).toBe(true)
    })

    it('preserves shareAnalytics when not provided', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        shareAnalytics: true,
      })
      const res = await putSettings({ app: { showMenuBarIcon: false } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.shareAnalytics).toBe(true)
    })

    it('can set shareAnalytics to false', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        shareAnalytics: true,
      })
      const res = await putSettings({ shareAnalytics: false })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.shareAnalytics).toBe(false)
    })
  })

  // =========================================================================
  // Settings merge — computerUse
  // =========================================================================
  describe('computerUse handling', () => {
    it('merges computerUse with existing', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        computerUse: { agentPermissions: { 'agent-1': { grants: [{ level: 'use_host_shell', grantType: 'always' }] } } },
      })
      const res = await putSettings({ computerUse: { agentPermissions: { 'agent-2': { grants: [{ level: 'list_apps_windows', grantType: 'always' }] } } } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.computerUse.agentPermissions).toHaveProperty('agent-2')
    })

    it('preserves computerUse when not provided', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        computerUse: { agentPermissions: { 'agent-1': { grants: [{ level: 'use_host_shell', grantType: 'always' }] } } },
      })
      const res = await putSettings({ app: { showMenuBarIcon: false } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.computerUse).toEqual({ agentPermissions: { 'agent-1': { grants: [{ level: 'use_host_shell', grantType: 'always' }] } } })
    })
  })

  // =========================================================================
  // Settings merge — analyticsTargets
  // =========================================================================
  describe('analyticsTargets handling', () => {
    it('replaces analyticsTargets when provided', async () => {
      const newTargets = [
        { type: 'amplitude', config: { apiKey: 'amp-key' }, enabled: true },
      ]
      const res = await putSettings({ analyticsTargets: newTargets })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.analyticsTargets).toEqual(newTargets)
    })

    it('preserves analyticsTargets when not provided', async () => {
      const existingTargets = [
        { type: 'mixpanel', config: { token: 'mp-tok' }, enabled: true },
      ]
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        analyticsTargets: existingTargets,
      })
      const res = await putSettings({ app: { showMenuBarIcon: false } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.analyticsTargets).toEqual(existingTargets)
    })
  })

  // =========================================================================
  // Settings merge — runtimeSettings
  // =========================================================================
  describe('runtimeSettings handling', () => {
    it('merges runtimeSettings with existing', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        container: {
          ...defaultSettings().container,
          runtimeSettings: { docker: { network: 'bridge' } },
        },
      })
      const res = await putSettings({
        container: {
          runtimeSettings: { lima: { vmMemory: '8GiB' } },
        },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      // shallow merge: lima added, docker from existing merged at top level
      expect(saved.container.runtimeSettings.lima).toEqual({ vmMemory: '8GiB' })
      expect(saved.container.runtimeSettings.docker).toEqual({ network: 'bridge' })
    })

    it('preserves runtimeSettings when not provided in body', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        container: {
          ...defaultSettings().container,
          runtimeSettings: { docker: { network: 'host' } },
        },
      })
      const res = await putSettings({
        container: { agentImage: 'new:v2' },
      })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.container.runtimeSettings).toEqual({ docker: { network: 'host' } })
    })
  })

  // =========================================================================
  // Empty / minimal body
  // =========================================================================
  describe('empty body handling', () => {
    it('preserves all settings when body is empty object', async () => {
      const res = await putSettings({})
      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
      const saved = mockUpdateSettings.mock.calls[0][0]
      // all fields preserved from defaults
      expect(saved.container).toEqual(defaultSettings().container)
      expect(saved.app).toEqual(defaultSettings().app)
      expect(saved.apiKeys).toEqual(defaultSettings().apiKeys)
      expect(saved.models).toEqual(defaultSettings().models)
      expect(saved.agentLimits).toEqual(defaultSettings().agentLimits)
      expect(saved.skillsets).toEqual(defaultSettings().skillsets)
    })

    it('handles body with only non-settings fields gracefully', async () => {
      const res = await putSettings({ unknownField: 'ignored' } as Record<string, unknown>)
      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
    })
  })

  // =========================================================================
  // PUT response shape
  // =========================================================================
  describe('PUT response shape', () => {
    it('returns all expected GlobalSettingsResponse fields', async () => {
      const res = await putSettings({ app: { showMenuBarIcon: false } })
      expect(res.status).toBe(200)
      const body = await res.json()

      // Verify all expected top-level keys exist
      expect(body).toHaveProperty('dataDir')
      expect(body).toHaveProperty('container')
      expect(body).toHaveProperty('app')
      expect(body).toHaveProperty('hasRunningAgents')
      expect(body).toHaveProperty('runnerAvailability')
      expect(body).toHaveProperty('llmProvider')
      expect(body).toHaveProperty('llmProviderStatus')
      expect(body).toHaveProperty('apiKeyStatus')
      expect(body).toHaveProperty('models')
      expect(body).toHaveProperty('agentLimits')
      expect(body).toHaveProperty('customEnvVars')
      expect(body).toHaveProperty('setupCompleted')
      expect(body).toHaveProperty('hostBrowserStatus')
      expect(body).toHaveProperty('runtimeReadiness')
      expect(body).toHaveProperty('voice')
      expect(body).toHaveProperty('tenantId')
      expect(body).toHaveProperty('shareAnalytics')

      // Verify apiKeyStatus sub-keys
      expect(body.apiKeyStatus).toHaveProperty('anthropic')
      expect(body.apiKeyStatus).toHaveProperty('openrouter')
      expect(body.apiKeyStatus).toHaveProperty('bedrock')
      expect(body.apiKeyStatus).toHaveProperty('browserbase')
      expect(body.apiKeyStatus).toHaveProperty('composio')
      expect(body.apiKeyStatus).toHaveProperty('deepgram')
      expect(body.apiKeyStatus).toHaveProperty('openai')
    })

    it('PUT response reflects the updated settings', async () => {
      const res = await putSettings({
        app: { showMenuBarIcon: false },
        llmProvider: 'openrouter',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.app.showMenuBarIcon).toBe(false)
      expect(body.llmProvider).toBe('openrouter')
    })
  })

  // =========================================================================
  // GET response shape
  // =========================================================================
  describe('GET response shape', () => {
    it('returns all expected GlobalSettingsResponse fields', async () => {
      const res = await app.request('http://localhost/api/settings')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body).toHaveProperty('dataDir')
      expect(body).toHaveProperty('container')
      expect(body).toHaveProperty('app')
      expect(body).toHaveProperty('hasRunningAgents')
      expect(body).toHaveProperty('runnerAvailability')
      expect(body).toHaveProperty('llmProvider')
      expect(body).toHaveProperty('llmProviderStatus')
      expect(body).toHaveProperty('apiKeyStatus')
      expect(body).toHaveProperty('models')
      expect(body).toHaveProperty('agentLimits')
      expect(body).toHaveProperty('customEnvVars')
      expect(body).toHaveProperty('setupCompleted')
      expect(body).toHaveProperty('hostBrowserStatus')
      expect(body).toHaveProperty('runtimeReadiness')
      expect(body).toHaveProperty('voice')
      expect(body).toHaveProperty('tenantId')
      expect(body).toHaveProperty('shareAnalytics')
    })
  })
})
