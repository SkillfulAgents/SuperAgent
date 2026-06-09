import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// SUP-229 — Chat integration session clear can archive sessions from another
// integration (cross-tenant IDOR).
//
// `DELETE /api/chat-integrations/:integrationId/sessions/:sessionId` authorizes
// the caller against :integrationId but loads the session row by sessionId and
// archives/clears it without verifying `session.integrationId === integrationId`.
// A user with 'user' role on integration A's agent can archive any session row
// belonging to a different integration B / agent.
//
// Seeded scenario:
//   integration A (agentSlug 'agent-a')  -> attacker has 'user'
//   integration B (agentSlug 'agent-b')  -> attacker has NO role
//   sessionOfB.integrationId === B
// Request: DELETE /chat-integrations/<A>/sessions/<sessionOfB> must be rejected
// (404) and must NOT call clearChatSessionById / archiveChatIntegrationSession.
// ---------------------------------------------------------------------------

const INTEGRATION_A = 'integration-a'
const INTEGRATION_B = 'integration-b'
const SESSION_OF_B = 'session-of-b'
const SESSION_OF_A = 'session-of-a'

const mockAuthUser = { id: 'attacker-user', name: 'Attacker', email: 'attacker@example.com' }

// Auth middleware — faithful passthrough. EntityAgentRole authorizes the URL
// integration only (attacker has 'user' on agent-a), exactly mirroring how the
// real middleware scopes auth to :integrationId and never sees the session.
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  EntityAgentRole: (opts: any) => (_minRole: string) => async (c: any, next: () => Promise<void>) => {
    const id = c.req.param(opts.paramName)
    const entity = await opts.lookupFn(id)
    if (!entity) return c.json({ error: `${opts.entityName} not found` }, 404)
    c.set(opts.contextKey, entity)
    c.set('user', mockAuthUser)
    return next()
  },
}))

// Two integrations: A (agent-a) and B (agent-b).
const integrations: Record<string, { id: string; agentSlug: string }> = {
  [INTEGRATION_A]: { id: INTEGRATION_A, agentSlug: 'agent-a' },
  [INTEGRATION_B]: { id: INTEGRATION_B, agentSlug: 'agent-b' },
}
const mockGetChatIntegration = vi.fn(async (id: string) => integrations[id] ?? null)

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (id: string) => mockGetChatIntegration(id),
  createChatIntegration: vi.fn(),
  updateChatIntegration: vi.fn(),
  updateChatIntegrationStatus: vi.fn(),
  deleteChatIntegration: vi.fn(),
  DuplicateBotTokenError: class DuplicateBotTokenError extends Error {},
}))

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

import chatIntegrationsRouter from './chat-integrations'

function app() {
  const a = new Hono()
  a.route('/api/chat-integrations', chatIntegrationsRouter)
  return a
}

describe('SUP-229: chat session clear must not archive sessions from another integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChatIntegration.mockImplementation(async (id: string) => integrations[id] ?? null)
  })

  it('rejects clearing a chat session that belongs to a different integration', async () => {
    // Session row belongs to integration B; the request authorizes A.
    mockGetChatIntegrationSessionById.mockReturnValue({
      id: SESSION_OF_B,
      integrationId: INTEGRATION_B,
      sessionId: 'b-agent-session',
      archivedAt: null,
    })

    const res = await app().request(
      `http://localhost/api/chat-integrations/${INTEGRATION_A}/sessions/${SESSION_OF_B}`,
      { method: 'DELETE' },
    )

    expect(res.status).toBe(404)
    expect(mockClearChatSessionById).not.toHaveBeenCalled()
    expect(mockArchiveChatIntegrationSession).not.toHaveBeenCalled()
  })

  it('clears a chat session that belongs to the authorized integration', async () => {
    mockGetChatIntegrationSessionById.mockReturnValue({
      id: SESSION_OF_A,
      integrationId: INTEGRATION_A,
      sessionId: 'a-agent-session',
      archivedAt: null,
    })

    const res = await app().request(
      `http://localhost/api/chat-integrations/${INTEGRATION_A}/sessions/${SESSION_OF_A}`,
      { method: 'DELETE' },
    )

    expect(res.status).toBe(200)
    expect(mockClearChatSessionById).toHaveBeenCalledWith(SESSION_OF_A)
    expect(mockArchiveChatIntegrationSession).toHaveBeenCalledWith(SESSION_OF_A)
  })
})
