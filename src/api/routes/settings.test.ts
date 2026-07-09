import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
const mockGetNangoApiKeyStatus = vi.fn()
const mockGetAccountProviderUserId = vi.fn()
const mockGetDefaultAccountProviderType = vi.fn()
const mockGetNangoSecretKey = vi.fn()
const mockFsPromises = vi.hoisted(() => ({
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('<svg />')),
}))
const mockAuthenticatedMiddleware = vi.hoisted(() =>
  vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
)
// Host total memory for the VM-memory sizing guard. Default is large enough
// that every allowlisted option passes; sizing tests shrink it.
const mockTotalmem = vi.hoisted(() => vi.fn(() => 64 * 1024 ** 3))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, totalmem: mockTotalmem },
    totalmem: mockTotalmem,
  }
})
const mockIsAdminMiddleware = vi.hoisted(() =>
  vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
)

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  // The PUT route now reads currentSettings via the fail-closed strict loader
  // map it to the same seeded settings the tests already provide.
  loadSettingsStrict: (...args: unknown[]) => mockGetSettings(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  clearSettingsCache: (...args: unknown[]) => mockClearSettingsCache(...args),
  getAnthropicApiKeyStatus: (...args: unknown[]) => mockGetAnthropicApiKeyStatus(...args),
  getComposioApiKeyStatus: (...args: unknown[]) => mockGetComposioApiKeyStatus(...args),
  getComposioUserId: (...args: unknown[]) => mockGetComposioUserId(...args),
  getEffectiveModels: (...args: unknown[]) => mockGetEffectiveModels(...args),
  getEffectiveAgentLimits: (...args: unknown[]) => mockGetEffectiveAgentLimits(...args),
  getModelCatalogSettings: () => mockGetSettings().modelCatalog ?? {},
  getCustomEnvVars: (...args: unknown[]) => mockGetCustomEnvVars(...args),
  getVoiceSettings: (...args: unknown[]) => mockGetVoiceSettings(...args),
  getBrowserbaseApiKeyStatus: (...args: unknown[]) => mockGetBrowserbaseApiKeyStatus(...args),
  getNangoApiKeyStatus: (...args: unknown[]) => mockGetNangoApiKeyStatus(...args),
  getAccountProviderUserId: (...args: unknown[]) => mockGetAccountProviderUserId(...args),
  getDefaultAccountProviderType: (...args: unknown[]) => mockGetDefaultAccountProviderType(...args),
  getNangoSecretKey: (...args: unknown[]) => mockGetNangoSecretKey(...args),
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
  getContainerClientClass: (runner: string) => ({
    supportsCustomAgentImage: runner !== 'lambda-microvm',
  }),
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
  Authenticated: () => mockAuthenticatedMiddleware,
  IsAdmin: () => mockIsAdminMiddleware,
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
  userSettings: {},
  auditLog: {},
  webhookTriggers: {},
  chatIntegrations: {},
  chatIntegrationSessions: {},
  chatIntegrationAccess: {},
  remoteMcpServers: {},
  agentRemoteMcps: {},
  mcpAuditLog: {},
  mcpToolPolicies: {},
  agentAcl: {},
  messageAuthor: {},
  xAgentPolicies: {},
  apiScopePolicies: {},
}))

vi.mock('fs', () => ({
  default: { promises: mockFsPromises },
}))

vi.mock('@shared/lib/analytics/tenant-id', () => ({
  getTenantId: () => 'mock-tenant-id',
}))

vi.mock('path', async (importOriginal) => {
  // Keep the simplified, deterministic join, but delegate the rest (resolve,
  // relative, isAbsolute, sep) to the real module so path-safety helpers work.
  const actual = await importOriginal<typeof import('path')>()
  return {
    ...actual,
    default: { ...actual, join: (...args: string[]) => args.join('/') },
  }
})

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
  mockGetNangoApiKeyStatus.mockReturnValue({ isConfigured: false, source: 'none' })
  mockGetAccountProviderUserId.mockReturnValue(undefined)
  mockGetDefaultAccountProviderType.mockReturnValue('composio')
  mockGetNangoSecretKey.mockReturnValue(undefined)
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
  mockTotalmem.mockReturnValue(64 * 1024 ** 3)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings route', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFsPromises.rm.mockResolvedValue(undefined)
    mockFsPromises.mkdir.mockResolvedValue(undefined)
    mockFsPromises.writeFile.mockResolvedValue(undefined)
    mockFsPromises.readFile.mockResolvedValue(Buffer.from('<svg />'))
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
  // Agent image locked for deployment-managed runners
  // =========================================================================
  describe('agentImage guard for runners without custom image support', () => {
    it('returns 400 when changing agentImage while lambda-microvm is the configured runner', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        container: {
          containerRunner: 'lambda-microvm',
          agentImage: 'superagent:latest',
          resourceLimits: { cpu: 2, memory: '4g' },
        },
      })

      const res = await putSettings({
        container: { agentImage: 'ghcr.io/custom/image:v9' },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('managed by the deployment')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('returns 400 when switching to lambda-microvm and changing agentImage in one request', async () => {
      const res = await putSettings({
        container: { containerRunner: 'lambda-microvm', agentImage: 'ghcr.io/custom/image:v9' },
      })

      expect(res.status).toBe(400)
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('accepts an unchanged agentImage for lambda-microvm', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        container: {
          containerRunner: 'lambda-microvm',
          agentImage: 'superagent:latest',
          resourceLimits: { cpu: 2, memory: '4g' },
        },
      })

      const res = await putSettings({
        container: { agentImage: 'superagent:latest' },
      })

      expect(res.status).toBe(200)
      expect(mockUpdateSettings).toHaveBeenCalledOnce()
    })

    it('still allows agentImage changes for runners that support it', async () => {
      const res = await putSettings({
        container: { agentImage: 'ghcr.io/custom/image:v9' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.container.agentImage).toBe('ghcr.io/custom/image:v9')
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

    it('resets models to the new provider defaults when the active provider changes', async () => {
      // currentSettings has no llmProvider (→ effective 'anthropic'); switching to
      // Bedrock must drop the old pins and adopt Bedrock's bare-alias defaults so a
      // bare-Claude id can't leak into the Bedrock catalog.
      const res = await putSettings({ llmProvider: 'bedrock' })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.llmProvider).toBe('bedrock')
      expect(saved.models).toEqual({
        summarizerModel: 'haiku',
        agentModel: 'sonnet',
        browserModel: 'sonnet',
        dashboardBuilderModel: 'opus',
      })
    })

    it('keeps an explicit models payload even when the provider changes', async () => {
      const res = await putSettings({
        llmProvider: 'bedrock',
        models: { agentModel: 'us.anthropic.claude-opus-4-7' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      // Explicit pin wins; the other fields merge from current, not the reset.
      expect(saved.models.agentModel).toBe('us.anthropic.claude-opus-4-7')
      expect(saved.models.summarizerModel).toBe('claude-3-haiku')
    })

    it('does not reset models when the provider is unchanged', async () => {
      const res = await putSettings({ app: { showMenuBarIcon: false } })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.models).toEqual({
        summarizerModel: 'claude-3-haiku',
        agentModel: 'claude-sonnet-4-20250514',
        browserModel: 'claude-3-haiku',
      })
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

    // SUP-210: reject customEnvVars that try to override reserved runtime vars.
    it('rejects customEnvVars containing a reserved runtime key (400)', async () => {
      const res = await putSettings({
        customEnvVars: { PROXY_TOKEN: 'attacker', MY_OK: 'fine' },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('PROXY_TOKEN')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('accepts customEnvVars with only non-reserved keys (200)', async () => {
      const res = await putSettings({
        customEnvVars: { MY_OK: 'fine', ANOTHER: 'x' },
      })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.customEnvVars).toEqual({ MY_OK: 'fine', ANOTHER: 'x' })
    })

    it('replaces modelCatalog entirely when valid overrides are provided', async () => {
      const modelCatalog = {
        anthropic: {
          overrides: [{ id: 'claude-opus-4-8', disabled: true }],
        },
      }

      const res = await putSettings({ modelCatalog })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.modelCatalog).toEqual(modelCatalog)
    })

    it('rejects invalid modelCatalog payloads and does not persist', async () => {
      const res = await putSettings({
        modelCatalog: {
          anthropic: {
            overrides: [{ id: '', disabled: true }],
          },
        },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBeTruthy()
      expect(mockUpdateSettings).not.toHaveBeenCalled()
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
  // Quick-dispatch global shortcut validation
  // =========================================================================
  describe('app.globalDispatchShortcut validation', () => {
    it('accepts a valid accelerator (200)', async () => {
      const res = await putSettings({ app: { globalDispatchShortcut: 'CommandOrControl+Shift+K' } })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.globalDispatchShortcut).toBe('CommandOrControl+Shift+K')
    })

    it('accepts an empty string as "disabled" (200)', async () => {
      const res = await putSettings({ app: { globalDispatchShortcut: '' } })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.globalDispatchShortcut).toBe('')
    })

    it('rejects a garbage accelerator (400) and does not persist', async () => {
      const res = await putSettings({ app: { globalDispatchShortcut: 'not a shortcut' } })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('globalDispatchShortcut')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('rejects a non-string accelerator (400)', async () => {
      const res = await putSettings({ app: { globalDispatchShortcut: 123 } })

      expect(res.status).toBe(400)
      expect(mockUpdateSettings).not.toHaveBeenCalled()
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
  // LLM key validation (uses the REAL provider classes over mocked settings)
  // =========================================================================
  describe('POST /validate-llm-key', () => {
    async function validateLlmKey(body: Record<string, unknown>): Promise<Response> {
      return app.request('http://localhost/api/settings/validate-llm-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    const savedGenericKeyEnv = process.env.GENERIC_API_KEY
    beforeEach(() => {
      delete process.env.GENERIC_API_KEY
    })
    afterEach(() => {
      if (savedGenericKeyEnv === undefined) delete process.env.GENERIC_API_KEY
      else process.env.GENERIC_API_KEY = savedGenericKeyEnv
      vi.unstubAllGlobals()
    })

    it('returns 400 for an empty apiKey on a non-generic provider', async () => {
      const res = await validateLlmKey({ provider: 'openrouter', apiKey: '' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('API key is required')
    })

    it('lets the generic provider revalidate a base-URL-only change with the saved key', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: { genericApiKey: 'saved-key', genericBaseUrl: 'http://old.example.com:4000' },
      })
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
      vi.stubGlobal('fetch', fetchMock)

      const res = await validateLlmKey({
        provider: 'generic',
        apiKey: '',
        baseUrl: 'http://ollama.example.com:11434',
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ valid: true })
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://ollama.example.com:11434/v1/models')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer saved-key' })
    })

    it('reports a key requirement for generic when no key is given or saved', async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings(), apiKeys: {} })
      const res = await validateLlmKey({ provider: 'generic', apiKey: '', baseUrl: 'http://ollama.example.com:11434' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ valid: false, error: 'API key is required' })
    })

    it('rejects a bare single-label hostname for the generic provider', async () => {
      const res = await validateLlmKey({ provider: 'generic', apiKey: 'k', baseUrl: 'http://my-gpu-box:11434' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(false)
      expect(body.error).toContain('bare hostname')
    })
  })

  describe('POST /validate-web-key', () => {
    async function validate(body: unknown) {
      return app.request('http://localhost/api/settings/validate-web-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('returns 400 when apiKey is missing', async () => {
      const res = await validate({ provider: 'exa' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('API key is required')
    })

    it('returns 400 when the provider is missing or native', async () => {
      const res = await validate({ apiKey: 'k', provider: 'native' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('vendor is required')
    })

    it('returns 400 for an unknown provider', async () => {
      const res = await validate({ apiKey: 'k', provider: 'bogus' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('Unknown web provider')
    })

    // Platform is a registered vendor, so it would otherwise dispatch into the registry and fire a
    // billable proxy call with a key it does not use.
    it('rejects platform without dispatching (login-based, not key-based)', async () => {
      const res = await validate({ apiKey: 'k', provider: 'platform' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('Gamut login')
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

    it('refuses VM memory equal to host total memory', async () => {
      mockTotalmem.mockReturnValue(16 * 1024 ** 3)
      const res = await putSettings({
        container: {
          runtimeSettings: { lima: { vmMemory: '16GiB' } },
        },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('total memory')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('refuses VM memory above host total memory', async () => {
      mockTotalmem.mockReturnValue(8 * 1024 ** 3)
      const res = await putSettings({
        container: {
          runtimeSettings: { lima: { vmMemory: '12GiB' } },
        },
      })
      expect(res.status).toBe(400)
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('accepts VM memory above half of host total (warn is UI-side, not a rejection)', async () => {
      mockTotalmem.mockReturnValue(16 * 1024 ** 3)
      const res = await putSettings({
        container: {
          runtimeSettings: { lima: { vmMemory: '12GiB' } },
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
  // Settings merge — web favicon
  // =========================================================================
  describe('web favicon handling', () => {
    const pngDataUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`

    it('stores a valid favicon data URL and stamps the update time', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-06-20T01:02:03.000Z'))

      const res = await putSettings({ app: { faviconDataUrl: pngDataUrl } })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.faviconDataUrl).toBe(pngDataUrl)
      expect(saved.app.faviconUpdatedAt).toBe('2026-06-20T01:02:03.000Z')

      vi.useRealTimers()
    })

    it('rejects an invalid favicon payload', async () => {
      const res = await putSettings({ app: { faviconDataUrl: 'data:text/html;base64,PGgxPk5vcGU8L2gxPg==' } })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Favicon must be')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('removes the custom favicon when set to null', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-06-20T02:03:04.000Z'))
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        app: {
          showMenuBarIcon: true,
          faviconDataUrl: pngDataUrl,
          faviconUpdatedAt: '2026-06-20T01:02:03.000Z',
        },
      })

      const res = await putSettings({ app: { faviconDataUrl: null } })

      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.app.faviconDataUrl).toBeUndefined()
      expect(saved.app.faviconUpdatedAt).toBe('2026-06-20T02:03:04.000Z')

      vi.useRealTimers()
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

    it('preserves webProvider when not provided (PUT must not strip it)', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        webProvider: 'exa',
      })
      const res = await putSettings({ app: { showMenuBarIcon: false } })
      expect(res.status).toBe(200)
      const saved = mockUpdateSettings.mock.calls[0][0]
      expect(saved.webProvider).toBe('exa')
    })

    it('stores platform as an explicit webProvider choice', async () => {
      const res = await putSettings({ webProvider: 'platform' })
      expect(res.status).toBe(200)
      expect(mockUpdateSettings.mock.calls[0][0].webProvider).toBe('platform')
    })

    it('clears webProvider to automatic (stored undefined) when sent null', async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings(), webProvider: 'exa' })
      const res = await putSettings({ webProvider: null })
      expect(res.status).toBe(200)
      expect(mockUpdateSettings.mock.calls[0][0].webProvider).toBeUndefined()
    })

    it('rejects an unknown webProvider id at the boundary without writing', async () => {
      const res = await putSettings({ webProvider: 'bogus' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('Invalid webProvider')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
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
      expect(body).toHaveProperty('modelCatalog')
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

  describe('model icon uploads', () => {
    it('stores uploaded icons in the data dir and returns a catalog icon key', async () => {
      const formData = new FormData()
      formData.set('file', new File(['<svg />'], 'custom.svg', { type: 'image/svg+xml' }))

      const res = await app.request('http://localhost/api/settings/model-icons', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.icon).toMatch(/^uploaded:[a-f0-9-]+\.svg$/)
      expect(mockFsPromises.mkdir).toHaveBeenCalledWith('/mock/data/model-icons', { recursive: true })
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/data\/model-icons\/[a-f0-9-]+\.svg$/),
        expect.any(Buffer),
        { mode: 0o600 },
      )
    })

    it('rejects unsupported icon file types', async () => {
      const formData = new FormData()
      formData.set('file', new File(['not an image'], 'custom.txt', { type: 'text/plain' }))

      const res = await app.request('http://localhost/api/settings/model-icons', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      expect(mockFsPromises.writeFile).not.toHaveBeenCalled()
    })

    it('serves uploaded icons from the data dir', async () => {
      mockFsPromises.readFile.mockResolvedValueOnce(Buffer.from('<svg />'))

      const res = await app.request('http://localhost/api/settings/model-icons/abc-123.svg')

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('image/svg+xml')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe('<svg />')
      expect(mockFsPromises.readFile).toHaveBeenCalledWith('/mock/data/model-icons/abc-123.svg')
    })

    it('serves uploaded icons without requiring admin authorization', async () => {
      mockFsPromises.readFile.mockResolvedValueOnce(Buffer.from('<svg />'))

      const res = await app.request('http://localhost/api/settings/model-icons/abc-123.svg')

      expect(res.status).toBe(200)
      expect(mockAuthenticatedMiddleware).toHaveBeenCalled()
      expect(mockIsAdminMiddleware).not.toHaveBeenCalled()
    })

    it('rejects invalid uploaded icon filenames', async () => {
      const res = await app.request('http://localhost/api/settings/model-icons/not-allowed.gif')

      expect(res.status).toBe(400)
      expect(mockFsPromises.readFile).not.toHaveBeenCalled()
    })
  })

  describe('provider model search', () => {
    it('rejects providers that do not support model search', async () => {
      const res = await app.request('http://localhost/api/settings/llm-providers/anthropic/models/search?q=claude')

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('does not support model search')
    })

    it('searches provider-native catalogs and returns normalized model listings', async () => {
      mockGetSettings.mockReturnValue({
        ...defaultSettings(),
        apiKeys: {
          ...defaultSettings().apiKeys,
          openrouterApiKey: 'sk-or-test',
        },
      })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4',
              name: 'GPT-4',
              description: 'GPT-4 is a capable model.',
              context_length: 8192,
              architecture: { tokenizer: 'GPT' },
              pricing: { prompt: '0.00003', completion: '0.00006' },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      try {
        const res = await app.request('http://localhost/api/settings/llm-providers/openrouter/models/search?q=gpt')

        expect(res.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledOnce()
        expect(String(fetchSpy.mock.calls[0][0])).toContain('q=gpt')
        expect(fetchSpy.mock.calls[0][1]).toMatchObject({
          headers: { Authorization: 'Bearer sk-or-test' },
        })
        const body = await res.json()
        expect(body.data).toEqual([
          expect.objectContaining({
            id: 'openai/gpt-4',
            label: 'GPT-4',
            family: 'gpt',
            icon: 'openai',
            blurb: 'GPT-4 is a capable model.',
            supportedEfforts: ['low', 'medium', 'high'],
            pricing: { inputPerMtok: 30, outputPerMtok: 60 },
            contextWindow: 8192,
            supportsWebSearch: false,
          }),
        ])
      } finally {
        fetchSpy.mockRestore()
      }
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
      expect(body).toHaveProperty('modelCatalog')
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
