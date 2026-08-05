import type { ChatIntegrationSession, ChatIntegrationAccess } from '@shared/lib/db/schema'
import type { PublicChatIntegration as ChatIntegration } from '@shared/lib/chat-integrations/public'

/** Schema-complete ChatIntegration for component tests; override any field. */
export function makeChatIntegration(overrides: Partial<ChatIntegration> = {}): ChatIntegration {
  return {
    id: 'int-1',
    agentSlug: 'a',
    provider: 'telegram',
    name: 'Bot',
    hasCredentials: true,
    settings: {},
    showToolCalls: false,
    requireApproval: false,
    sessionTimeout: null,
    model: null,
    effort: null,
    speed: null,
    status: 'active',
    errorMessage: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ChatIntegration
}

/** Schema-complete conversation window; `externalChatId`/`sessionId` are required. */
export function makeSession(
  over: Partial<ChatIntegrationSession> & { externalChatId: string; sessionId: string },
): ChatIntegrationSession {
  const now = new Date('2026-06-20T12:00:00Z')
  return {
    id: `sess-row-${over.sessionId}`,
    integrationId: 'int-1',
    displayName: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

/** Schema-complete access entry; `externalChatId`/`status` are required. */
export function makeAccess(
  over: Partial<ChatIntegrationAccess> & { externalChatId: string; status: ChatIntegrationAccess['status'] },
): ChatIntegrationAccess {
  const now = new Date('2026-06-20T12:00:00Z')
  return {
    id: `acc-${over.externalChatId}`,
    integrationId: 'int-1',
    chatType: 'private',
    approvalSource: null,
    title: null,
    firstUserId: null,
    firstUserName: null,
    firstMessagePreview: null,
    requestNoticeSentAt: null,
    requestedAt: now,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}
