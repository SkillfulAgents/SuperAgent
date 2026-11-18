/**
 * What is known about an agent, a session and a message, read from the
 * stores that hold it today. Three snapshots, one per lifetime; a caller
 * asks for the ones it needs.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { agentRegistry, type Sender, type Source } from '@shared/lib/agent-actor'
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { integrationMessageDisplaySchema } from '@shared/lib/agent-integrations/message-display-schema'
import type { AgentIntegrationProvider } from '@shared/lib/agent-integrations/provider-types'
import { db } from '@shared/lib/db'
import {
  chatIntegrationSessions,
  chatIntegrations,
  messageAuthor,
  scheduledTasks,
  webhookTriggers,
} from '@shared/lib/db/schema'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { getAgentOwnerUserId } from './agent-owner'
import { getAgentRecord } from './agent-service'
import { sessionOrigin } from './session-visibility'

export type IntegrationFamily = 'chat' | 'email' | 'meeting' | 'task-manager'

/** The agent. The same for every session. */
export interface AgentContext {
  /** The first owner; absent outside auth mode. */
  ownerId?: string
}

/** How the session started. `kind` is `sessionOrigin()`. Ids are absent only on sessions older than the field. */
export type SessionStart =
  | { kind: 'user' }
  | { kind: 'integration'; integrationId?: string; provider?: AgentIntegrationProvider; family?: IntegrationFamily }
  | { kind: 'scheduled'; taskId?: string; executionAt?: string }
  | { kind: 'webhook'; triggerId?: string }
  | { kind: 'agent'; callerSlug: string }
  | { kind: 'widget-repair'; widgetSlug?: string }

/** The session. Set when it starts. */
export interface SessionContext {
  origin: SessionStart
  /** The session's creator; for a cron or webhook session, who made the cron or webhook. */
  createdBy?: Sender
}

export type SessionContextField = keyof SessionContext

/** The message the session acts on. */
export interface MessageContext {
  sender: Sender
  source: Source
  /** Epoch ms. */
  sentAt: number
}

/** Throws when the agent does not exist. */
export async function getAgentContext(agentSlug: string): Promise<AgentContext> {
  const [agent, ownerId] = await Promise.all([getAgentRecord(agentSlug), getAgentOwnerUserId(agentSlug)])
  if (!agent) throw new Error(`Agent not found: ${agentSlug}`)
  return ownerId ? { ownerId } : {}
}

/**
 * Reads only what `fields` need, independent reads in parallel. `already`:
 * the session's metadata, when the caller just read it. Throws when the
 * session does not exist.
 */
export async function getSessionContext<F extends SessionContextField>(
  agentSlug: string,
  sessionId: string,
  fields: readonly F[],
  already?: { metadata: SessionMetadata | null },
): Promise<Pick<SessionContext, F>> {
  const actor = agentRegistry.get(agentSlug)
  // Every field reads the metadata, and it says whether the session exists.
  const meta = already ? already.metadata : await actor.sessions.metadata(sessionId)
  if (!meta && !(await actor.sessions.isKnown(sessionId))) throw new Error(`Session not found: ${sessionId}`)

  const read: { [K in SessionContextField]: () => Promise<SessionContext[K]> } = {
    origin: async () =>
      sessionStart(meta, sessionOrigin(meta) === 'integration' ? await readChatMapping(agentSlug, sessionId) : undefined),
    createdBy: async () => {
      const userId = (await automationCreator(meta)) ?? meta?.createdByUserId
      return userId ? { kind: 'user', userId } : undefined
    },
  }

  const context: Partial<SessionContext> = {}
  await Promise.all(fields.map(async (field) => {
    context[field] = await read[field]()
  }))
  // Each asked field was read above.
  return context as Pick<SessionContext, F>
}

/**
 * While a turn runs: the message that started it, or the queued one the
 * runtime picked up, as the live session keeps it. Otherwise (a restart, or
 * no turn running): the newest saved sender, or an automation's own run.
 * Undefined when no sender is known (sign-in off, a failed sender write, a
 * session older than sender records, a system notice); readers keep their default.
 */
export async function getMessageContext(agentSlug: string, sessionId: string): Promise<MessageContext | undefined> {
  const actor = agentRegistry.get(agentSlug)
  const live = await actor.sessions.live(sessionId)
  if (live.isActive && live.turnMessage) {
    const { from, sentAt } = live.turnMessage
    return from ? { ...from, sentAt } : undefined
  }

  const row = await db.select({
    userId: messageAuthor.userId,
    integrationId: messageAuthor.integrationId,
    display: messageAuthor.display,
    createdAt: messageAuthor.createdAt,
  }).from(messageAuthor)
    .where(and(eq(messageAuthor.agentSlug, agentSlug), eq(messageAuthor.sessionId, sessionId)))
    .orderBy(desc(messageAuthor.createdAt), desc(messageAuthor.id))
    .limit(1)
    .get()

  if (row?.userId) {
    return { sender: { kind: 'user', userId: row.userId }, source: { kind: 'app' }, sentAt: row.createdAt.getTime() }
  }
  if (row?.integrationId) {
    const chat = await db.select({ externalId: chatIntegrationSessions.externalChatId }).from(chatIntegrationSessions)
      .where(and(eq(chatIntegrationSessions.sessionId, sessionId), eq(chatIntegrationSessions.integrationId, row.integrationId)))
      .orderBy(desc(chatIntegrationSessions.createdAt))
      .limit(1)
      .get()
    return {
      sender: { kind: 'external', integrationId: row.integrationId, ...displayedSenderName(row.display) },
      source: { kind: 'integration', integrationId: row.integrationId, ...(chat ? { externalId: chat.externalId } : {}) },
      sentAt: row.createdAt.getTime(),
    }
  }

  const meta = await actor.sessions.metadata(sessionId)
  const sender = automationSender(meta)
  const sentAt = Date.parse(meta?.scheduledExecutionAt ?? meta?.createdAt ?? '')
  return sender && !Number.isNaN(sentAt) ? { sender, source: { kind: 'automation' }, sentAt } : undefined
}

/** The newest person who wrote in the app in this session, when one did. */
export async function getNewestAppSenderId(agentSlug: string, sessionId: string): Promise<string | undefined> {
  const row = await db.select({ userId: messageAuthor.userId }).from(messageAuthor)
    .where(and(
      eq(messageAuthor.agentSlug, agentSlug),
      eq(messageAuthor.sessionId, sessionId),
      isNotNull(messageAuthor.userId),
    ))
    .orderBy(desc(messageAuthor.createdAt), desc(messageAuthor.id))
    .limit(1)
    .get()
  return row?.userId ?? undefined
}

type ChatMapping = NonNullable<Awaited<ReturnType<typeof readChatMapping>>>

/** The session's chat mapping and its integration, in one read. */
async function readChatMapping(agentSlug: string, sessionId: string) {
  return await db.select({
    integrationId: chatIntegrationSessions.integrationId,
    provider: chatIntegrations.provider,
  }).from(chatIntegrationSessions)
    .innerJoin(chatIntegrations, and(
      eq(chatIntegrations.id, chatIntegrationSessions.integrationId),
      eq(chatIntegrations.agentSlug, agentSlug),
    ))
    .where(eq(chatIntegrationSessions.sessionId, sessionId))
    .orderBy(desc(chatIntegrationSessions.createdAt))
    .limit(1)
    .get()
}

/** Who made the cron or webhook that started the session, when it did. */
async function automationCreator(meta: SessionMetadata | null): Promise<string | undefined> {
  const origin = sessionOrigin(meta)
  if (origin === 'scheduled' && meta?.scheduledTaskId) {
    const task = await db.select({ userId: scheduledTasks.createdByUserId }).from(scheduledTasks)
      .where(eq(scheduledTasks.id, meta.scheduledTaskId)).get()
    return task?.userId ?? undefined
  }
  if (origin === 'webhook' && meta?.webhookTriggerId) {
    const trigger = await db.select({ userId: webhookTriggers.createdByUserId }).from(webhookTriggers)
      .where(eq(webhookTriggers.id, meta.webhookTriggerId)).get()
    return trigger?.userId ?? undefined
  }
  return undefined
}

function sessionStart(meta: SessionMetadata | null, chat: ChatMapping | undefined): SessionStart {
  switch (sessionOrigin(meta)) {
    case 'scheduled':
      return {
        kind: 'scheduled',
        ...(meta?.scheduledTaskId ? { taskId: meta.scheduledTaskId } : {}),
        ...(meta?.scheduledExecutionAt ? { executionAt: meta.scheduledExecutionAt } : {}),
      }
    case 'webhook':
      return { kind: 'webhook', ...(meta?.webhookTriggerId ? { triggerId: meta.webhookTriggerId } : {}) }
    case 'integration': {
      const integrationId = meta?.agentIntegrationId ?? meta?.chatIntegrationId ?? chat?.integrationId
      const provider = chat && chat.integrationId === integrationId ? chat.provider : undefined
      return {
        kind: 'integration',
        ...(integrationId ? { integrationId } : {}),
        ...(provider ? { provider, ...familyField(provider) } : {}),
      }
    }
    case 'agent': {
      // sessionOrigin() says 'agent' only when the slug is set.
      const callerSlug = meta?.invokedByAgentSlug
      return callerSlug ? { kind: 'agent', callerSlug } : { kind: 'user' }
    }
    case 'widget-repair':
      return { kind: 'widget-repair', ...(meta?.widgetRepairSlug ? { widgetSlug: meta.widgetRepairSlug } : {}) }
    case 'user':
      return { kind: 'user' }
  }
}

function automationSender(meta: SessionMetadata | null): Sender | undefined {
  const origin = sessionOrigin(meta)
  if (origin === 'scheduled' && meta?.scheduledTaskId) return { kind: 'automation', trigger: 'scheduled', id: meta.scheduledTaskId }
  if (origin === 'webhook' && meta?.webhookTriggerId) return { kind: 'automation', trigger: 'webhook', id: meta.webhookTriggerId }
  if (origin === 'widget-repair' && meta?.widgetRepairSlug) return { kind: 'automation', trigger: 'widget-repair', id: meta.widgetRepairSlug }
  return undefined
}

/** The person on the message's card, else the integration's name as the card shows it. */
function displayedSenderName(display: string | null): { name?: string } {
  let card: unknown
  try {
    card = JSON.parse(display ?? '')
  } catch {
    return {}
  }
  const parsed = integrationMessageDisplaySchema.safeParse(card)
  return parsed.success ? { name: parsed.data.request?.author?.name ?? parsed.data.integration.name } : {}
}

const FAMILIES = ['chat', 'email', 'meeting', 'task-manager'] as const

function familyField(provider: AgentIntegrationProvider): { family?: IntegrationFamily } {
  const family = narrow(FAMILIES, agentIntegrationRegistry.getDefinition(provider)?.family)
  return family ? { family } : {}
}

function narrow<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.includes(value as T) ? (value as T) : undefined
}
