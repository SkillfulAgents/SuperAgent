import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: any, next: () => Promise<void>) => {
    c.set('agentId', c.req.param('id'))
    return next()
  },
  getAgentId: (c: any) => c.get('agentId') ?? c.req.param('id'),
}))

const mockGetHostApiBaseUrl = vi.fn()
const mockContainerFetch = vi.fn()
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({
      fetch: (...args: unknown[]) => mockContainerFetch(...args),
      getHostApiBaseUrl: (...args: unknown[]) => mockGetHostApiBaseUrl(...args),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    ensureRunning: vi.fn(),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
  },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
  },
}))

const mockSelectFrom = vi.fn()
const mockInsertValues = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockSelectFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {},
  agentConnectedAccounts: {},
  proxyAuditLog: {},
  remoteMcpServers: {
    id: 'id',
    name: 'name',
    status: 'status',
    toolsJson: 'tools_json',
    userId: 'user_id',
  },
  agentRemoteMcps: {
    id: 'id',
    agentSlug: 'agent_slug',
    remoteMcpId: 'remote_mcp_id',
  },
  mcpAuditLog: {},
  agentAcl: {},
  user: {},
  messageAuthor: {},
  apiScopePolicies: {},
  mcpToolPolicies: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
  inArray: (col: string, vals: string[]) => ({ col, vals }),
  desc: (col: string) => ({ col }),
  count: () => 'count',
  like: (col: string, val: string) => ({ col, val }),
  or: (...args: unknown[]) => args,
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => false,
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => 'test-user-id',
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(),
  createAgent: vi.fn(),
  getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  agentExists: vi.fn().mockResolvedValue(true),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: vi.fn(),
  updateSessionName: vi.fn(),
  registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(),
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
  deleteSession: vi.fn(),
  removeMessage: vi.fn(),
  removeToolCall: vi.fn(),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  keyToEnvVar: vi.fn(),
  getSecretEnvVars: vi.fn(),
}))

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listScheduledTasks: vi.fn(),
  listPendingScheduledTasks: vi.fn(),
}))

vi.mock('@shared/lib/account-providers', () => ({
  getProvider: vi.fn(),
}))

vi.mock('@shared/lib/services/skillset-service', () => ({
  getAgentSkillsWithStatus: vi.fn(),
  getDiscoverableSkills: vi.fn(),
  installSkillFromSkillset: vi.fn(),
  updateSkillFromSkillset: vi.fn(),
  createSkillPR: vi.fn(),
  getSkillPRInfo: vi.fn(),
  getSkillPublishInfo: vi.fn(),
  publishSkillToSkillset: vi.fn(),
  refreshAgentSkills: vi.fn(),
}))

vi.mock('@shared/lib/services/artifact-service', () => ({
  listArtifactsFromFilesystem: vi.fn(),
}))

// Must not be used for REMOTE_MCPS proxyUrl — runtime talk-back goes through getHostApiBaseUrl.
vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => 'host.docker.internal',
  getAppPort: () => 3000,
}))

vi.mock('@shared/lib/services/agent-template-service', () => ({
  exportAgentTemplate: vi.fn(),
  importAgentFromTemplate: vi.fn(),
  installAgentFromSkillset: vi.fn(),
  updateAgentFromSkillset: vi.fn(),
  getAgentTemplateStatus: vi.fn(),
  getDiscoverableAgents: vi.fn(),
  refreshSkillsetCaches: vi.fn(),
  getAgentPRInfo: vi.fn(),
  createAgentPR: vi.fn(),
  getAgentPublishInfo: vi.fn(),
  publishAgentToSkillset: vi.fn(),
  refreshAgentTemplates: vi.fn(),
  hasOnboardingSkill: vi.fn(),
}))

vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: vi.fn(),
}))

vi.mock('@shared/lib/utils/message-transform', () => ({
  transformMessages: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({}),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {} }),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  revokeProxyToken: vi.fn(),
  validateProxyToken: vi.fn(),
}))

vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: vi.fn(),
  readFileOrNull: vi.fn(),
  getAgentSessionsDir: vi.fn(),
  readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: vi.fn(),
}))

vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

vi.mock('@shared/lib/auth/ownership', () => ({
  ownerScope: () => ({}),
}))

vi.mock('@shared/lib/services/mount-service', () => ({
  getMountsWithHealth: vi.fn(),
  addMount: vi.fn(),
  removeMount: vi.fn(),
}))

vi.mock('@shared/lib/services/agent-hooks-service', () => ({
  readAgentHooks: vi.fn(),
  removeAgentHook: vi.fn(),
}))

vi.mock('@shared/lib/services/agent-hooks-schema', () => ({
  removeAgentHookSchema: {},
}))

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  listWebhookTriggers: vi.fn(),
  listActiveWebhookTriggers: vi.fn(),
  listCancelledWebhookTriggers: vi.fn(),
}))

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  listChatIntegrations: vi.fn(),
  listChatIntegrationsByAgents: vi.fn(),
}))

vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {},
}))

vi.mock('@shared/lib/services/notification-service', () => ({
  getSessionIdsWithUnreadNotifications: vi.fn(),
  getUnreadNotificationsByAgents: vi.fn(),
  deleteNotificationsBySessionIds: vi.fn(),
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {},
}))

vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  listXAgentPolicies: vi.fn(),
  upsertXAgentPolicy: vi.fn(),
  deleteXAgentPolicy: vi.fn(),
}))

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: vi.fn(),
  updateAgentPreferences: vi.fn(),
}))

vi.mock('@shared/lib/types/agent-preferences', () => ({
  agentPreferencesUpdateSchema: { parse: (v: unknown) => v },
}))

vi.mock('@shared/lib/services/agent-cleanup-service', () => ({
  cleanupAgentData: vi.fn(),
}))

vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: {},
}))

vi.mock('@shared/lib/computer-use/executor', () => ({
  executeComputerUseCommand: vi.fn(),
  checkACPermissions: vi.fn(),
  ungrabAC: vi.fn(),
}))

vi.mock('@shared/lib/computer-use/types', () => ({
  resolveTargetApp: vi.fn(),
}))

vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: vi.fn(),
  createSummarizerText: vi.fn(),
}))

vi.mock('@shared/lib/llm-provider', () => ({
  resolveActiveProviderModel: vi.fn(),
}))

vi.mock('@shared/lib/skillset-provider', () => ({
  getSkillsetProvider: vi.fn(),
}))

vi.mock('@shared/lib/container/runtime-options', () => ({
  parseRuntimeOptions: vi.fn(),
}))

vi.mock('@shared/lib/tool-definitions/user-input-tools', () => ({
  isBlockingUserInputToolName: vi.fn(),
}))

vi.mock('@shared/lib/container/reserved-env-vars', () => ({
  isReservedEnvVar: vi.fn(),
}))

vi.mock('@shared/lib/proxy/scope-matcher', () => ({
  isValidApiScope: vi.fn(),
}))

vi.mock('@shared/lib/proxy/policy-sentinels', () => ({
  isLabelDefaultKey: vi.fn(),
}))

vi.mock('@shared/lib/utils/mime', () => ({
  guessMimeType: vi.fn(),
}))

vi.mock('@shared/lib/utils/http-range', () => ({
  parseByteRange: vi.fn(),
}))

vi.mock('@shared/lib/utils/path-safety', () => ({
  isPathWithinDir: vi.fn(),
  sanitizeUploadFilename: vi.fn(),
}))

vi.mock('@shared/lib/utils/package-extensions', () => ({
  AGENT_PACKAGE_EXTENSION: '.agent',
  SKILL_PACKAGE_EXTENSION: '.skill',
}))

vi.mock('../speech-recognition-polyfill', () => ({
  getPolyfillJs: () => '',
}))

vi.mock('../llm-polyfill', () => ({
  getLlmPolyfillJs: () => '',
}))

import agents from './agents'

function createApp() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

describe('provide-remote-mcp handler', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockInsertValues.mockResolvedValue(undefined)
    mockGetHostApiBaseUrl.mockResolvedValue('http://10.20.107.8:3000')
  })

  const ENDPOINT = '/api/agents/test-agent/sessions/sess-1/provide-remote-mcp'

  async function postJson(body: unknown): Promise<Response> {
    return app.request(`http://localhost${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('writes REMOTE_MCPS proxyUrl from getHostApiBaseUrl, not host.docker.internal', async () => {
    // requested servers status check → active
    mockSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([
        { id: 'mcp-1', name: 'DialMCP', status: 'active' },
      ]),
    })

    // existing mappings lookup → none yet
    mockSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([]),
    })

    // all agent MCP mappings after insert
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            mcp: {
              id: 'mcp-1',
              name: 'DialMCP',
              status: 'active',
              toolsJson: JSON.stringify([{ name: 'place_call' }]),
            },
          },
        ]),
      }),
    })

    mockContainerFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }), text: async () => '' })

    const res = await postJson({
      toolUseId: 'tu-1',
      remoteMcpId: 'mcp-1',
    })

    expect(res.status).toBe(200)
    expect(mockGetHostApiBaseUrl).toHaveBeenCalledOnce()

    const envCall = mockContainerFetch.mock.calls.find(([path]) => path === '/env')
    expect(envCall).toBeDefined()
    const envBody = JSON.parse(envCall![1].body as string)
    expect(envBody.key).toBe('REMOTE_MCPS')

    const configs = JSON.parse(envBody.value) as Array<{ id: string; proxyUrl: string }>
    expect(configs).toHaveLength(1)
    expect(configs[0].proxyUrl).toBe('http://10.20.107.8:3000/api/mcp-proxy/test-agent/mcp-1')
    expect(configs[0].proxyUrl).not.toContain('host.docker.internal')
  })

  it('rejects non-active servers with 409 instead of resolving a no-op grant', async () => {
    // requested servers status check → needs re-auth
    mockSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([
        { id: 'mcp-1', name: 'Granola', status: 'auth_required' },
      ]),
    })

    const res = await postJson({
      toolUseId: 'tu-1',
      remoteMcpId: 'mcp-1',
    })

    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; needsReauth: boolean; inactiveMcpIds: string[] }
    expect(body.needsReauth).toBe(true)
    expect(body.inactiveMcpIds).toEqual(['mcp-1'])
    expect(body.error).toContain('Granola')
    expect(body.error).toContain('re-authentication')

    // Neither the agent mapping nor the pending input in the container is touched
    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockContainerFetch).not.toHaveBeenCalled()
  })
})

describe('Agent Settings remote MCP live sync', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockGetHostApiBaseUrl.mockResolvedValue('http://10.20.107.8:3000')
  })

  it('updates REMOTE_MCPS in a running container after assignment', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined)
    mockInsertValues.mockReturnValueOnce({ onConflictDoNothing })

    // Existing assignments lookup → none.
    mockSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([]),
    })
    // Runtime projection after insert.
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            mcp: {
              id: 'mcp-1',
              name: 'Calendar',
              status: 'active',
              toolsJson: JSON.stringify([{ name: 'list_events' }]),
            },
          },
        ]),
      }),
    })
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '',
    })

    const res = await app.request('http://localhost/api/agents/test-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['mcp-1'] }),
    })

    expect(res.status).toBe(200)
    expect(onConflictDoNothing).toHaveBeenCalledOnce()
    const envCall = mockContainerFetch.mock.calls.find(([path]) => path === '/env')
    expect(envCall).toBeDefined()
    const envBody = JSON.parse(envCall![1].body as string)
    const configs = JSON.parse(envBody.value)
    expect(configs).toEqual([
      {
        id: 'mcp-1',
        name: 'Calendar',
        proxyUrl: 'http://10.20.107.8:3000/api/mcp-proxy/test-agent/mcp-1',
        tools: [{ name: 'list_events' }],
      },
    ])
  })

  it('updates REMOTE_MCPS in a running container after removal', async () => {
    // Mapping ownership lookup.
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'mapping-1' }]),
        }),
      }),
    })
    // Runtime projection after delete → empty.
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '',
    })

    const res = await app.request(
      'http://localhost/api/agents/test-agent/remote-mcps/mcp-1',
      { method: 'DELETE' },
    )

    expect(res.status).toBe(204)
    const envCall = mockContainerFetch.mock.calls.find(([path]) => path === '/env')
    expect(envCall).toBeDefined()
    const envBody = JSON.parse(envCall![1].body as string)
    expect(JSON.parse(envBody.value)).toEqual([])
  })
})
