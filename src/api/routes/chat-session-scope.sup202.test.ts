import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// SUP-202 — Chat session clear/archive must be scoped to the URL integrationId.
//
// `DELETE /api/chat-integrations/:integrationId/sessions/:sessionId` authorizes
// the caller against :integrationId (via IntegrationAgentRole), but the handler
// loads the session purely by primary-key sessionId and clears/archives it
// without verifying `session.integrationId === integrationId`. A user with
// 'user' access to one integration can therefore clear/archive a session that
// belongs to a DIFFERENT integration (and another agent) by knowing its row id
// (BOLA / cross-tenant IDOR).
//
// We mount the REAL chatIntegrationsRouter with the auth middleware reduced to a
// faithful passthrough (the URL integration IS one the attacker can access, so
// authorization legitimately succeeds), and spy on the session-service /
// manager mutators to assert they never fire for a foreign session.
// ---------------------------------------------------------------------------

const ATTACKER_INTEGRATION_ID = 'attacker-integration-id'
const VICTIM_INTEGRATION_ID = 'victim-integration-id'
const VICTIM_SESSION_ROW_ID = 'victim-session'

const mockAuthUser = { id: 'attacker-user', name: 'Attacker', email: 'attacker@example.com' }

// Auth middleware — faithful passthrough. EntityAgentRole loads the integration
// named by the URL param (so authorization is scoped to :integrationId, exactly
// like production) and proceeds; in this repro the attacker holds 'user' on that
// integration's agent, so the real role check would pass anyway.
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  ResolveAgent: () => async (c: any, next: () => Promise<void>) => { c.set('agentId', c.req.param('id')); return next() },
  getAgentId: (c: any) => c.get('agentId') ?? c.req.param('id'),
  EntityAgentRole: (opts: any) => (_minRole: string) => async (c: any, next: () => Promise<void>) => {
    const id = c.req.param(opts.paramName)
    const entity = await opts.lookupFn(id)
    if (!entity) return c.json({ error: `${opts.entityName} not found` }, 404)
    c.set(opts.contextKey, entity)
    c.set('user', mockAuthUser)
    return next()
  },
}))

// getChatIntegration resolves only the attacker's own integration — the auth
// layer never sees the victim integration or session.
const mockGetChatIntegration = vi.fn(async (id: string) =>
  id === ATTACKER_INTEGRATION_ID ? { id: ATTACKER_INTEGRATION_ID, agentSlug: 'attacker-agent' } : null,
)

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (id: string) => mockGetChatIntegration(id),
  createChatIntegration: vi.fn(),
  updateChatIntegration: vi.fn(),
  updateChatIntegrationStatus: vi.fn(),
  deleteChatIntegration: vi.fn(),
  DuplicateBotTokenError: class DuplicateBotTokenError extends Error {},
}))

// Session service — getChatIntegrationSessionById is an UNSCOPED `WHERE id = ?`
// lookup, so it returns the victim session row (which carries integrationId).
const mockGetChatIntegrationSessionById = vi.fn()
const mockArchiveChatIntegrationSession = vi.fn()

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSessionById: (id: string) => mockGetChatIntegrationSessionById(id),
  archiveChatIntegrationSession: (id: string) => mockArchiveChatIntegrationSession(id),
  listChatIntegrationSessions: vi.fn(() => []),
  deleteChatIntegrationSessionsByIntegration: vi.fn(),
}))

const mockClearChatSessionById = vi.fn()
vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {
    clearChatSessionById: (id: string) => mockClearChatSessionById(id),
    isIntegrationConnected: vi.fn(() => false),
    addIntegration: vi.fn(),
    removeIntegration: vi.fn(),
    pauseIntegration: vi.fn(),
    resumeIntegration: vi.fn(),
  },
}))

vi.mock('@shared/lib/chat-integrations/config-schema', () => ({
  validateChatIntegrationConfig: vi.fn(),
  CHAT_PROVIDERS: ['telegram', 'slack', 'imessage'],
  IMESSAGE_GATEWAY_URL: 'https://imessage.example.com',
  imessageSetupSchema: { safeParse: () => ({ success: true, data: {} }) },
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => mockAuthUser.id,
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

// Import the router after all mocks are registered.
import chatIntegrationsRouter from './chat-integrations'

function app() {
  const a = new Hono()
  a.route('/api/chat-integrations', chatIntegrationsRouter)
  return a
}

describe('SUP-202: chat session clear/archive must be scoped to the URL integration (BOLA)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChatIntegration.mockImplementation(async (id: string) =>
      id === ATTACKER_INTEGRATION_ID ? { id: ATTACKER_INTEGRATION_ID, agentSlug: 'attacker-agent' } : null,
    )
  })

  it('rejects clearing a chat session that belongs to a different integration', async () => {
    // Victim session row belongs to a different integration entirely.
    mockGetChatIntegrationSessionById.mockReturnValue({
      id: VICTIM_SESSION_ROW_ID,
      integrationId: VICTIM_INTEGRATION_ID,
      sessionId: 'victim-agent-session',
      archivedAt: null,
    })

    const res = await app().request(
      `http://localhost/api/chat-integrations/${ATTACKER_INTEGRATION_ID}/sessions/${VICTIM_SESSION_ROW_ID}`,
      { method: 'DELETE' },
    )

    expect(res.status).toBe(404)
    expect(mockClearChatSessionById).not.toHaveBeenCalled()
    expect(mockArchiveChatIntegrationSession).not.toHaveBeenCalled()
  })

  it('still clears a chat session that belongs to the authorized integration', async () => {
    // Legit session — its integrationId matches the URL param.
    mockGetChatIntegrationSessionById.mockReturnValue({
      id: 'own-session',
      integrationId: ATTACKER_INTEGRATION_ID,
      sessionId: 'own-agent-session',
      archivedAt: null,
    })

    const res = await app().request(
      `http://localhost/api/chat-integrations/${ATTACKER_INTEGRATION_ID}/sessions/own-session`,
      { method: 'DELETE' },
    )

    expect(res.status).toBe(200)
    expect(mockClearChatSessionById).toHaveBeenCalledWith('own-session')
    expect(mockArchiveChatIntegrationSession).toHaveBeenCalledWith('own-session')
  })

  it('returns 404 without mutating when the session does not exist', async () => {
    mockGetChatIntegrationSessionById.mockReturnValue(null)

    const res = await app().request(
      `http://localhost/api/chat-integrations/${ATTACKER_INTEGRATION_ID}/sessions/missing-session`,
      { method: 'DELETE' },
    )

    expect(res.status).toBe(404)
    expect(mockClearChatSessionById).not.toHaveBeenCalled()
    expect(mockArchiveChatIntegrationSession).not.toHaveBeenCalled()
  })
})
