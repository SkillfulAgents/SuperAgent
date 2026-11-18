/**
 * What is known about an agent, a session and a message: every fact that
 * changes how a session behaves, read from the stores that hold it today.
 * Three snapshots, one per lifetime; a caller asks for the ones it needs.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { agentRegistry, type Sender, type Source } from '@shared/lib/agent-actor'
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { integrationMessageDisplaySchema } from '@shared/lib/agent-integrations/message-display-schema'
import type { AgentIntegrationProvider } from '@shared/lib/agent-integrations/provider-types'
import { isAuthMode } from '@shared/lib/auth/mode'
import { EFFORT_LEVELS, SPEED_LEVELS, type EffortLevel, type SpeedLevel } from '@shared/lib/container/types'
import { db } from '@shared/lib/db'
import {
  agentAcl,
  chatIntegrationAccess,
  chatIntegrationSessions,
  chatIntegrations,
  messageAuthor,
  scheduledTasks,
  webhookTriggers,
} from '@shared/lib/db/schema'
import type { AgentRole, SessionMetadata } from '@shared/lib/types/agent'
import { normalizeAutomationStatus, type AutomationStatus } from './activity-aggregation'
import { getAgentRecord } from './agent-service'
import { isHiddenAutomatedSession, sessionOrigin } from './session-visibility'

export type IntegrationFamily = 'chat' | 'email' | 'meeting' | 'task-manager'

/** The agent. The same for every session. */
export interface AgentContext {
  /** The first owner; absent outside auth mode. */
  ownerId?: string
  /** `agent_acl`, oldest first; empty outside auth mode. */
  members: { userId: string; role: AgentRole }[]
}

/** How the session started. `kind` is `sessionOrigin()`. Ids are absent only on sessions older than the field. */
export type SessionStart =
  | { kind: 'user' }
  | { kind: 'integration'; integrationId?: string; provider?: AgentIntegrationProvider; family?: IntegrationFamily }
  | { kind: 'scheduled'; taskId?: string; executionAt?: string }
  | { kind: 'webhook'; triggerId?: string }
  | { kind: 'agent'; callerSlug: string }
  | { kind: 'widget-repair'; widgetSlug?: string }

/** The integration chat, thread or work item the session belongs to. */
export interface IntegrationConversation {
  integrationId: string
  provider: AgentIntegrationProvider
  family?: IntegrationFamily
  /** Slack channel or thread, Telegram chat, Linq chat, email thread, Linear issue, GitHub issue or meeting id. */
  externalId: string
  /** Chat family only, when known. */
  chatType?: 'dm' | 'group' | 'thread'
  /** Epoch ms. */
  archivedAt?: number
}

/** The session. Set when it starts, or changed by its state. */
export interface SessionContext {
  origin: SessionStart
  /** The session's creator; for a cron or webhook session, who made the cron or webhook. */
  createdBy?: Sender
  conversation?: IntegrationConversation
  /** Not started in the app and not promoted to interactive: no session list shows it. */
  hidden: boolean
  runtime: { model?: string; llmProviderId?: string | null; effort?: EffortLevel; speed?: SpeedLevel }
  permissions: { chatApproval?: 'pending' | 'allowed' | 'denied' }
  lifecycle: {
    automationStatus?: AutomationStatus
    /** Exempt from auto-delete. */
    starred: boolean
    /** Transcript modified time, epoch ms. The auto-delete cutoff. */
    lastActivityAt: number
    /** A pending scheduled wake of this session. */
    wake?: { at: number; taskId: string }
  }
}

export type SessionContextField = keyof SessionContext

/** The message the session acts on. */
export interface MessageContext {
  sender: Sender
  source: Source
  /** null: sent from the web. */
  deviceId?: string | null
  /** Epoch ms. */
  sentAt: number
}

/** Throws when the agent does not exist. */
export async function getAgentContext(agentSlug: string): Promise<AgentContext> {
  const [agent, members] = await Promise.all([
    getAgentRecord(agentSlug),
    readMembers(agentSlug),
  ])
  if (!agent) throw new Error(`Agent not found: ${agentSlug}`)
  const ownerId = members.find((member) => member.role === 'owner')?.userId
  return { ...(ownerId ? { ownerId } : {}), members }
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
  const metadata = once(async () => {
    const meta = already ? already.metadata : await actor.sessions.metadata(sessionId)
    if (!meta && !(await actor.sessions.isKnown(sessionId))) throw new Error(`Session not found: ${sessionId}`)
    return meta
  })
  const conversation = once(() => readConversation(agentSlug, sessionId))

  const read: { [K in SessionContextField]: () => Promise<SessionContext[K]> } = {
    origin: async () => sessionStart(await metadata(), await conversation()),
    createdBy: async () => {
      const meta = await metadata()
      const userId = (await automationCreator(meta)) ?? meta?.createdByUserId
      return userId ? { kind: 'user', userId } : undefined
    },
    conversation: async () => {
      const row = await conversation()
      if (!row) return undefined
      const chatType = chatTypeOf(row)
      return {
        integrationId: row.integrationId,
        provider: row.provider,
        ...familyField(row.provider),
        externalId: row.externalId,
        ...(chatType ? { chatType } : {}),
        ...(row.archivedAt ? { archivedAt: row.archivedAt.getTime() } : {}),
      }
    },
    hidden: async () => isHiddenAutomatedSession(await metadata()),
    runtime: async () => {
      const meta = await metadata()
      const effort = narrow(EFFORT_LEVELS, meta?.effort)
      const speed = narrow(SPEED_LEVELS, meta?.speed)
      return {
        ...(meta?.model ? { model: meta.model } : {}),
        ...(meta?.llmProviderId !== undefined ? { llmProviderId: meta.llmProviderId } : {}),
        ...(effort ? { effort } : {}),
        ...(speed ? { speed } : {}),
      }
    },
    permissions: async () => {
      const approval = (await conversation())?.approval
      return approval ? { chatApproval: approval } : {}
    },
    lifecycle: async () => {
      const meta = await metadata()
      const [info, wake] = await Promise.all([actor.sessions.get(sessionId, { metadata: meta }), readWake(agentSlug, sessionId)])
      if (!info) throw new Error(`Session not found: ${sessionId}`)
      const automationStatus = normalizeAutomationStatus(meta?.automationStatus)
      return {
        ...(automationStatus ? { automationStatus } : {}),
        starred: meta?.starred === true,
        lastActivityAt: new Date(info.lastActivityAt).getTime(),
        ...(wake ? { wake: { at: wake.at.getTime(), taskId: wake.taskId } } : {}),
      }
    },
  }

  // The metadata read also says whether the session exists, so it always runs.
  const [, ...values] = await Promise.all([metadata(), ...fields.map((field) => read[field]())])
  return Object.fromEntries(fields.map((field, i) => [field, values[i]])) as unknown as Pick<SessionContext, F>
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

  const [row, meta] = await Promise.all([
    db.select({
      userId: messageAuthor.userId,
      integrationId: messageAuthor.integrationId,
      display: messageAuthor.display,
      createdAt: messageAuthor.createdAt,
    }).from(messageAuthor)
      .where(and(eq(messageAuthor.agentSlug, agentSlug), eq(messageAuthor.sessionId, sessionId)))
      .orderBy(desc(messageAuthor.createdAt), desc(messageAuthor.id))
      .limit(1)
      .get(),
    actor.sessions.metadata(sessionId),
  ])

  if (row?.userId) {
    // Absent alertDeviceId: never re-claimed since the session was created.
    const deviceId = meta?.alertDeviceId !== undefined ? meta.alertDeviceId : meta?.createdByDeviceId
    return {
      sender: { kind: 'user', userId: row.userId },
      source: { kind: 'app' },
      ...(deviceId !== undefined ? { deviceId } : {}),
      sentAt: row.createdAt.getTime(),
    }
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

  const sender = automationSender(meta)
  const sentAt = Date.parse(meta?.scheduledExecutionAt ?? meta?.createdAt ?? '')
  return sender && !Number.isNaN(sentAt) ? { sender, source: { kind: 'automation' }, sentAt } : undefined
}

async function readMembers(agentSlug: string): Promise<AgentContext['members']> {
  if (!isAuthMode()) return []
  return await db.select({ userId: agentAcl.userId, role: agentAcl.role }).from(agentAcl)
    .where(eq(agentAcl.agentSlug, agentSlug)).orderBy(asc(agentAcl.createdAt)).all()
}

type ConversationRow = NonNullable<Awaited<ReturnType<typeof readConversation>>>

/** The session's chat mapping, its integration and the chat's approval, in one read. */
async function readConversation(agentSlug: string, sessionId: string) {
  return await db.select({
    integrationId: chatIntegrationSessions.integrationId,
    externalId: chatIntegrationSessions.externalChatId,
    archivedAt: chatIntegrationSessions.archivedAt,
    provider: chatIntegrations.provider,
    accessChatType: chatIntegrationAccess.chatType,
    approval: chatIntegrationAccess.status,
  }).from(chatIntegrationSessions)
    .innerJoin(chatIntegrations, and(
      eq(chatIntegrations.id, chatIntegrationSessions.integrationId),
      eq(chatIntegrations.agentSlug, agentSlug),
    ))
    .leftJoin(chatIntegrationAccess, and(
      eq(chatIntegrationAccess.integrationId, chatIntegrationSessions.integrationId),
      eq(chatIntegrationAccess.externalChatId, chatIntegrationSessions.externalChatId),
    ))
    .where(eq(chatIntegrationSessions.sessionId, sessionId))
    .orderBy(desc(chatIntegrationSessions.createdAt))
    .limit(1)
    .get()
}

async function readWake(agentSlug: string, sessionId: string) {
  return await db.select({ taskId: scheduledTasks.id, at: scheduledTasks.nextExecutionAt }).from(scheduledTasks)
    .where(and(
      eq(scheduledTasks.agentSlug, agentSlug),
      eq(scheduledTasks.resumeSessionId, sessionId),
      eq(scheduledTasks.status, 'pending'),
    ))
    .orderBy(asc(scheduledTasks.nextExecutionAt))
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

function sessionStart(meta: SessionMetadata | null, conversation: ConversationRow | undefined): SessionStart {
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
      const integrationId = meta?.agentIntegrationId ?? meta?.chatIntegrationId ?? conversation?.integrationId
      const provider = conversation && conversation.integrationId === integrationId ? conversation.provider : undefined
      return {
        kind: 'integration',
        ...(integrationId ? { integrationId } : {}),
        ...(provider ? { provider, ...familyField(provider) } : {}),
      }
    }
    case 'agent':
      // sessionOrigin() says 'agent' only when the slug is set.
      return { kind: 'agent', callerSlug: meta?.invokedByAgentSlug as string }
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

function chatTypeOf(row: ConversationRow): IntegrationConversation['chatType'] {
  if (row.accessChatType === 'private') return 'dm'
  if (row.accessChatType === 'group' || row.accessChatType === 'supergroup') return 'group'
  // A Slack thread's chat id is `<channel>|<thread ts>`.
  if (row.provider === 'slack' && row.externalId.includes('|')) return 'thread'
  return undefined
}

function narrow<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.includes(value as T) ? (value as T) : undefined
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => (value ??= load())
}
