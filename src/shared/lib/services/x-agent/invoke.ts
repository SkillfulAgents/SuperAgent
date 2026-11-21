/**
 * Invoke: send a prompt to a target agent, in a new session or an existing
 * one, for an {@link XAgentCaller}. Returns what the caller gets, or the
 * refusal / failure with the HTTP status the agent route answers it with.
 */
import type { XAgentRuntime } from '@shared/lib/proxy/x-agent-review'

import { randomUUID } from 'crypto'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { deleteMessageAuthorBestEffort, insertMessageAuthorBestEffort } from '@shared/lib/services/message-author'
import { userExists } from '@shared/lib/services/user-profile-service'
import { isAuthMode } from '@shared/lib/auth/mode'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import { getAgentRecord } from '@shared/lib/services/agent-service'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { deliveryFailure, startFailure } from '@shared/lib/agent-actor/delivery-errors'
import type { FileOps } from '@shared/lib/agent-actor/types'
import type { ContainerSession, EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { clampEffortForDisplay, clampSpeedForDisplay } from '@shared/lib/container/runtime-options'
import { bindAgentModelChoice } from '@shared/lib/llm-provider/connection-runtime'
import { connectionCatalogFrom } from '@shared/lib/llm-provider/connections'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { getSettings } from '@shared/lib/config/settings'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { resolveSessionDefaults, type SessionRuntimePick } from '@shared/lib/services/session-defaults'
import { captureException } from '@shared/lib/error-reporting'
import { appendAttachedFiles } from '@shared/lib/utils/attached-files'
import {
  removeTransferredAttachments,
  transferXAgentAttachments,
  XAgentAttachmentError,
} from '@shared/lib/services/x-agent-attachment-service'
import {
  callerHasRoleOnTarget,
  callerLogFields,
  checkCallerPolicy,
  getOwnersOfAgent,
  startPolicyRead,
  startRead,
  type XAgentCaller,
} from './caller'
import {
  DELIVERY_CUTOFF_MS,
  SUBSCRIBE_TIMEOUT_MS,
  deliveryCutoffError,
  effectiveSyncWaitMs,
  lateDeliveryRevokedError,
  readLastAssistantMessage,
  subscribeWithTimeout,
  syncWaitPromotedNote,
  waitForTurnWithinBudget,
} from './sync-wait'
import { fail, type XAgentResult } from './operations'

const X_AGENT_SENTRY = { area: 'x-agent', op: 'invoke' } as const

/**
 * Resolve the user who sent the message currently driving an agent session.
 * In shared sessions this can differ from the session creator, so invocation
 * attribution must prefer the latest per-message author record.
 */
async function getLatestMessageAuthorUserId(
  agentSlug: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    // An incoming agent call carries the payer forward into the next call.
    const payer = sql<string | null>`coalesce(${messageAuthor.userId}, ${messageAuthor.billedUserId})`
    const rows = await db
      .select({ userId: payer })
      .from(messageAuthor)
      .where(and(
        eq(messageAuthor.agentSlug, agentSlug),
        eq(messageAuthor.sessionId, sessionId),
        isNotNull(payer),
      ))
      .orderBy(desc(messageAuthor.createdAt), desc(messageAuthor.id))
      .limit(1)
    return rows[0]?.userId ?? undefined
  } catch (error) {
    // Attribution is optional. A DB/read failure must never block the invoke.
    console.warn('[x-agent] failed to resolve triggering message author; continuing unattributed', {
      agentSlug,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

async function getAgentDisplayNameBestEffort(agentSlug: string): Promise<string> {
  try {
    const agent = await getAgentRecord(agentSlug)
    return agent?.name || agentSlug
  } catch (error) {
    // Human-readable naming is cosmetic and must not gate agent invocation.
    console.warn('[x-agent] failed to resolve caller display name; using slug', {
      agentSlug,
      error: error instanceof Error ? error.message : String(error),
    })
    return agentSlug
  }
}

/**
 * The model a new invoked session starts on: the caller's pick, checked
 * against the target agent's models and the member's plan, else the target's
 * default. Returns the pick for the start and what the card shows.
 */
async function invokeRuntime(
  targetSlug: string,
  model: string | undefined,
  effort: EffortLevel | undefined,
  speed: SpeedLevel | undefined,
): Promise<{ error: string } | { pick: SessionRuntimePick; runtime?: XAgentRuntime }> {
  const settings = await getSettings()
  const { agentPrefs, resolve } = await resolveSessionDefaults(settings, targetSlug)
  let bound: { model?: string; llmProviderId?: string }
  try {
    bound = await bindAgentModelChoice(model, agentPrefs, settings)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const pick = { ...bound, effort, speed }
  const resolved = await resolve(pick)
  // The resolve passes over a pick the member's plan cannot run.
  if (bound.model && (resolved.model !== bound.model || resolved.llmProviderId !== bound.llmProviderId)) {
    return { error: `Model "${model}" is not available on this plan. Leave out model to use the agent's default.` }
  }
  // Only a catalog model is named to the person: without a connections setup the name is the agent's own text.
  if (!('connection' in resolved)) return { pick }
  const catalogModel = connectionCatalogFrom(resolved.connection, settings).find((m) => m.id === resolved.wireModel)
  // A legacy-pinned default can run a wire id its connection's catalog does not list.
  if (!catalogModel) return { pick }
  const shownEffort = clampEffortForDisplay(resolved.effort, catalogModel.supportedEfforts)
  const shownSpeed = clampSpeedForDisplay(resolved.speed, catalogModel)
  return {
    pick,
    runtime: {
      // The catalog id the picker on the card matches against, not an alias.
      model: catalogModel.id,
      llmProviderId: resolved.llmProviderId,
      ...(shownEffort ? { effort: shownEffort } : {}),
      ...(shownSpeed ? { speed: shownSpeed } : {}),
      label: catalogModel.label,
    },
  }
}

/** Who a delivered prompt's `message_author` row names: the calling agent (billed to its person), or the user. */
function messageAuthorFields(
  caller: XAgentCaller,
  attributedUserId: string,
): { billedUserId: string; authorAgentSlug: string } | { userId: string } {
  return caller.kind === 'agent'
    ? { billedUserId: attributedUserId, authorAgentSlug: caller.agentSlug }
    : { userId: attributedUserId }
}

/**
 * A user caller's session metadata without the keys the service owns:
 * `invokedByAgentSlug` is an agent caller's provenance (and drives the one-hop
 * rule), and `createdByUserId` is the attributed user the service checked.
 */
function withoutServiceOwnedMetadata(metadata: Partial<SessionMetadata>): Partial<SessionMetadata> {
  const rest = { ...metadata }
  delete rest.invokedByAgentSlug
  delete rest.createdByUserId
  return rest
}

export interface InvokeInput {
  /** The target. An agent caller may leave it out to mean its own agent. */
  slug?: string
  prompt: string
  sessionId?: string
  sync?: boolean
  /** Paths in the calling agent's workspace; an agent caller only. */
  attachments?: string[]
  model?: string
  effort?: EffortLevel
  speed?: SpeedLevel
  /** Aborts an attachment transfer when the request goes away. */
  signal?: AbortSignal
  /**
   * How long a sync invoke may wait for the turn, in ms. Clamped to
   * (0, the configured maximum]; absent = the maximum. Not on the agent route.
   * A value that is not a positive finite number also means the maximum: it is
   * never "don't wait". The budget runs from entry, so container start and
   * session creation spend it too, and a short wait can be gone before the
   * turn is waited on (the call then answers 'running').
   */
  syncWaitMs?: number
}

export type InvokeOutcome =
  | { sessionId: string; status: 'running'; error?: string }
  | { sessionId: string; status: 'completed'; lastMessage: string | undefined }

export async function invokeAgent(caller: XAgentCaller, input: InvokeInput): Promise<XAgentResult<InvokeOutcome>> {
  // Stamp both clocks before any slow pre-work (policy review, container
  // startup, session creation): the sync budget governs how long we wait for
  // the turn, the delivery cutoff governs whether we deliver the prompt at all
  // — so the total response time stays under the container fetch's 300s header
  // timeout, and no prompt is delivered to a caller that already gave up.
  const syncWaitMs = effectiveSyncWaitMs(input.syncWaitMs)
  const syncDeadline = Date.now() + syncWaitMs
  const deliveryCutoff = Date.now() + DELIVERY_CUTOFF_MS
  const callerSlug = caller.kind === 'agent' ? caller.agentSlug : undefined
  const callerSessionId = caller.kind === 'agent' ? caller.sessionId : undefined
  const callerLog = callerLogFields(caller)
  const {
    slug: rawTargetSlug,
    prompt,
    sessionId: existingSessionId,
    sync,
    attachments = [],
    model,
    effort,
    speed,
    signal,
  } = input

  // Resolve display slug → the agent, so ACL / policy / runtime all use its id.
  // No slug means the caller's own agent.
  const rawTarget = rawTargetSlug ?? callerSlug
  const target = rawTarget === undefined ? null : await agentCatalog.resolveRecord(rawTarget)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug

  // What the checks below read depends only on the caller and the resolved
  // target, so the reads start together; each is awaited at its own check.
  const callerMetaRead = startRead(callerSlug && callerSessionId
    ? agentRegistry.get(callerSlug).sessions.metadata(callerSessionId)
    : Promise.resolve(null))
  const triggeringUserRead = startRead(isAuthMode() && callerSlug && callerSessionId
    ? getLatestMessageAuthorUserId(callerSlug, callerSessionId)
    : Promise.resolve(undefined))
  const access = startRead(callerHasRoleOnTarget(caller, targetSlug, 'user'))
  // No policy applies to the caller's own agent (checkAgentPolicy), nor to a user.
  const savedDecision = targetSlug === callerSlug
    ? undefined
    : startPolicyRead(caller, 'invoke', targetSlug)
  if (existingSessionId && (model || effort || speed)) {
    return fail(400, 'model, effort and speed apply to new sessions only. Leave them out to continue session_id on its own model.')
  }
  // Attachments are read from the calling agent's workspace; a user has none.
  if (caller.kind === 'user' && attachments.length > 0) {
    return fail(400, 'Attachments can only be sent by an agent.')
  }

  // One-hop rule: sessions started by an agent invoke cannot invoke further.
  const callerMeta = await callerMetaRead
  if (callerMeta?.invokedByAgentSlug) {
    return fail(
      403,
      `This session was invoked by agent "${callerMeta.invokedByAgentSlug}" and cannot invoke agents. ` +
        'Cross-agent invocation is one hop deep.',
    )
  }

  // A running session takes an invoke into its turn, so a session messaging
  // itself would read its own prompt as a follow-up, and a sync wait would wait
  // on the turn that is waiting for it.
  if (targetSlug === callerSlug && existingSessionId && existingSessionId === callerSessionId) {
    return fail(400, 'A session cannot send a message to itself. Omit session_id to start a worker session.')
  }

  // Capture the triggering message's author before a review prompt can pause
  // this request and newer messages can arrive in a shared caller session.
  // This remains a best-effort "latest author" heuristic until the container
  // can pass the exact driving message UUID.
  const triggeringUserId = await triggeringUserRead

  if (!(await access)) {
    return fail(403, 'Forbidden: caller has no user access to target agent')
  }

  // Attribute to the triggering message author. Session creator and caller
  // owner remain compatibility fallbacks for old sessions without author rows.
  // A user caller is attributed to themself.
  let attributedUserId: string | undefined = caller.kind === 'user'
    ? (isAuthMode() ? caller.userId : undefined)
    : triggeringUserId ?? callerMeta?.createdByUserId
  if (!attributedUserId && isAuthMode() && callerSlug) {
    try {
      attributedUserId = (await getOwnersOfAgent(callerSlug))[0]
    } catch (error) {
      // ACL checks already ran above; this second lookup is attribution-only.
      console.warn('[x-agent] failed to resolve caller owner for attribution; continuing unattributed', {
        callerSlug,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // A new session's model is checked and shown on the card before anyone
  // approves it. A blocked call is refused first, with no model lookup.
  let pick: SessionRuntimePick = {}
  let runtime: XAgentRuntime | undefined
  if (!existingSessionId) {
    if (await savedDecision === 'block') {
      return fail(403, 'Blocked by policy')
    }
    let checked: Awaited<ReturnType<typeof invokeRuntime>>
    try {
      checked = await runWithOptionalUser(attributedUserId, () => invokeRuntime(targetSlug, model, effort, speed))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[x-agent] invoke failed', { ...callerLog, targetSlug, stage: 'resolve_model', error: message })
      captureException(err, { tags: { ...X_AGENT_SENTRY, stage: 'resolve_model' }, extra: { ...callerLog, targetSlug } })
      return fail(500, `Failed to invoke agent (resolve_model): ${message}`)
    }
    if ('error' in checked) return fail(400, checked.error)
    pick = checked.pick
    runtime = checked.runtime
  }

  const policy = await checkCallerPolicy(caller, 'invoke', targetSlug, target.name, {
    preview: prompt.slice(0, 200),
    fileTransfer: attachments.length ? { kind: 'send', paths: attachments } : undefined,
    // Shows the review in the calling session, so a chat can answer it.
    callerSessionId,
    savedDecision,
    runtime,
  })
  if (!policy.allowed) {
    return fail(403, policy.reason ?? 'Forbidden')
  }
  // The person allowing the card picked another model for the new session.
  if (policy.pick) pick = policy.pick

  return runWithOptionalUser(attributedUserId, async (): Promise<XAgentResult<InvokeOutcome>> => {
    // Stages for runtime 500s: ensure_running → create_session / send_message.
    let stage = 'ensure_running'
    let stagedTargetDirectory: string | undefined
    let stagedTargetFiles: FileOps | undefined
    let promptDeliveryStarted = false
    try {
      const targetActor = agentRegistry.get(targetSlug)
      if (existingSessionId) {
        // Invoke rights on the target say nothing about the session id sent
        // with them. The target's live sessions take any id they are handed, so
        // a third agent's id would get attached to the target's container here —
        // and the target's transcript written under it.
        if (!(await targetActor.sessions.isKnown(existingSessionId))) {
          return fail(404, 'Session not found')
        }
        stage = 'ensure_running'
        await targetActor.container.start()
        const files = targetActor.files
        stagedTargetFiles = files
        let deliveredPrompt = prompt
        if (attachments.length > 0 && callerSlug) {
          stage = 'transfer_attachments'
          const transferred = await transferXAgentAttachments({
            sourceFiles: agentRegistry.get(callerSlug).files,
            targetFiles: files,
            sourcePaths: attachments,
            signal,
          })
          stagedTargetDirectory = transferred.targetDirectory
          deliveredPrompt = appendAttachedFiles(prompt, transferred.attachments.map((item) => item.targetPath))
        }
        // Last reply flushed before THIS prompt goes out — used to make sure a
        // fast turn's answer isn't confused with the previous turn's while the
        // new entry is still being written to the JSONL file.
        const replyBoundary = sync
          ? await targetActor.messages.findLastEntry(existingSessionId, { kind: 'assistant' })
          : null
        stage = 'subscribe'
        // Attached here rather than by the delivery, so the attach is bounded
        // and the cutoff below is checked after it.
        await subscribeWithTimeout(targetActor.sessions.attach(existingSessionId))
        // Checked AFTER every unbounded pre-send await (container startup and
        // the stream attach above) so only fast local writes remain between
        // here and sendMessage — a check followed by a slow await could still
        // deliver to a caller whose fetch died at the 300s header timeout.
        if (Date.now() > deliveryCutoff) {
          console.warn('[x-agent] delivery cutoff exceeded before send; prompt not delivered', {
            ...callerLog,
            targetSlug,
            sessionId: existingSessionId,
          })
          if (stagedTargetDirectory) {
            await removeTransferredAttachments(files, stagedTargetDirectory).catch(() => {})
          }
          return fail(504, deliveryCutoffError())
        }
        stage = 'send_message'
        let messageUuid: string | undefined
        if (isAuthMode() && attributedUserId) {
          const candidateUuid = randomUUID()
          const recorded = await insertMessageAuthorBestEffort({
            id: candidateUuid,
            sessionId: existingSessionId,
            agentSlug: targetSlug,
            ...messageAuthorFields(caller, attributedUserId),
          })
          if (recorded) messageUuid = candidateUuid
        }
        // What a message that never went leaves behind is removed; a failed
        // send that may have gone keeps both, so an accepted message never
        // references deleted bytes or loses its author.
        const discardUndelivered = async () => {
          promptDeliveryStarted = false
          if (messageUuid) await deleteMessageAuthorBestEffort(targetSlug, existingSessionId, messageUuid)
          if (stagedTargetDirectory) {
            await removeTransferredAttachments(files, stagedTargetDirectory).catch(() => {})
            stagedTargetDirectory = undefined
          }
        }
        promptDeliveryStarted = true
        try {
          // A session in the middle of a turn takes the prompt into that turn,
          // as a user's message does.
          await targetActor.messages.deliver({
            sessionId: existingSessionId,
            content: deliveredPrompt,
            uuid: messageUuid,
            // Automated for a user caller too, on purpose (SUP-1569): an
            // MCP-started session is hidden and promoted like an agent-invoked one.
            options: { isAutomated: true },
          })
        } catch (sendError) {
          if (deliveryFailure(sendError)?.accepted === false) await discardUndelivered()
          throw sendError
        }

        if (sync) {
          stage = 'wait_for_idle'
          let outcome: 'completed' | 'timeout'
          try {
            outcome = await waitForTurnWithinBudget(targetSlug, existingSessionId, syncDeadline)
          } catch (error) {
            return { ok: true, value: {
              sessionId: existingSessionId,
              status: 'running',
              error: error instanceof Error ? error.message : String(error),
            } }
          }
          if (outcome === 'timeout') {
            // Budget exhausted (whether before or during the wait) means the
            // target is simply still working — promote to the async contract
            // with explicit guidance so the caller polls instead of re-invoking
            // (a re-invoke duplicates the whole run).
            return { ok: true, value: {
              sessionId: existingSessionId,
              status: 'running',
              error: syncWaitPromotedNote(syncWaitMs),
            } }
          }
          const lastMessage = await readLastAssistantMessage(
            targetSlug,
            existingSessionId,
            replyBoundary?.uuid,
          )
          return { ok: true, value: {
            sessionId: existingSessionId,
            status: 'completed',
            lastMessage: lastMessage?.content,
          } }
        }
        return { ok: true, value: { sessionId: existingSessionId, status: 'running' } }
      }

      stage = 'ensure_running'
      await targetActor.container.start()
      const files = targetActor.files
      stagedTargetFiles = files
      let deliveredPrompt = prompt
      if (attachments.length > 0 && callerSlug) {
        stage = 'transfer_attachments'
        const transferred = await transferXAgentAttachments({
          sourceFiles: agentRegistry.get(callerSlug).files,
          targetFiles: files,
          sourcePaths: attachments,
          signal,
        })
        stagedTargetDirectory = transferred.targetDirectory
        deliveredPrompt = appendAttachedFiles(prompt, transferred.attachments.map((item) => item.targetPath))
      }
      const availableEnvVars = await getSecretEnvVars(targetSlug)
      // One read of the settings for this invocation's session start.
      const { agentLimits, customEnvVars, maxBrowserTabs, models, resolve } = await resolveSessionDefaults(await getSettings(), targetSlug)
      const resolved = await resolve(pick)
      // An agent's sessions are named after it; a user caller brings its own name.
      const sessionName = caller.kind === 'agent'
        ? `Invoked by ${await getAgentDisplayNameBestEffort(caller.agentSlug)}`
        : caller.sessionName
      const initialMessageUuid = isAuthMode() && attributedUserId
        ? randomUUID()
        : undefined

      // createSession delivers the prompt (initialMessage) — same cutoff rule
      // as sendMessage above.
      if (Date.now() > deliveryCutoff) {
        console.warn('[x-agent] delivery cutoff exceeded before create; prompt not delivered', {
          ...callerLog,
          targetSlug,
        })
        if (stagedTargetDirectory) {
          await removeTransferredAttachments(files, stagedTargetDirectory).catch(() => {})
        }
        return fail(504, deliveryCutoffError())
      }
      stage = 'create_session'
      // Creating the session IS the delivery (initialMessage carries the
      // prompt) and cannot be cancelled mid-flight. One that lands after the
      // cutoff, when the caller's fetch may already be dead, is revoked by the
      // start itself the moment it materializes, instead of leaving a ghost
      // run for the caller's retry to duplicate. A failed registration or
      // stream attach is revoked the same way: without the attach nothing
      // would persist the session's transcript.
      // Recorded as the session's creator only while that person exists (a
      // legacy id can outlive its user); the attribution row follows the start.
      const createdByUserId = initialMessageUuid && attributedUserId && (await userExists(attributedUserId))
        ? attributedUserId
        : undefined
      // The provenance a session carries: the invoking agent, or what the user caller supplies.
      const callerMetadata: Partial<SessionMetadata> = caller.kind === 'agent'
        ? { invokedByAgentSlug: caller.agentSlug }
        : withoutServiceOwnedMetadata(caller.sessionMetadata)
      promptDeliveryStarted = true
      let containerSession: ContainerSession
      try {
        containerSession = await targetActor.sessions.start({
          create: {
          availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
          initialMessage: deliveredPrompt,
          ...(initialMessageUuid ? { initialMessageUuid } : {}),
          model: resolved.model,
        llmProviderId: resolved.llmProviderId,
          browserModel: models.browserModel,
          dashboardBuilderModel: models.dashboardBuilderModel,
          effort: resolved.effort,
          speed: resolved.speed,
          maxOutputTokens: agentLimits.maxOutputTokens,
          maxThinkingTokens: agentLimits.maxThinkingTokens,
          maxTurns: agentLimits.maxTurns,
          maxBudgetUsd: agentLimits.maxBudgetUsd,
          customEnvVars,
          maxBrowserTabs,
          // Automated for a user caller too, on purpose (SUP-1569): an
          // MCP-started session is hidden and promoted like an agent-invoked one.
          metadata: { isAutomated: true },
        },
          name: sessionName,
          metadata: { ...callerMetadata, ...(createdByUserId ? { createdByUserId } : {}) },
          notAfter: deliveryCutoff,
          attachTimeoutMs: SUBSCRIBE_TIMEOUT_MS,
        })
      } catch (startErr) {
        if (stagedTargetDirectory) {
          await removeTransferredAttachments(files, stagedTargetDirectory).catch(() => {})
        }
        const failure = startFailure(startErr)
        if (failure?.code === 'created-late') {
          console.warn('[x-agent] delivery cutoff exceeded during create; the late session was revoked', { ...callerLog, targetSlug })
          return fail(504, lateDeliveryRevokedError())
        }
        if (failure?.code !== 'register-failed' && failure?.code !== 'attach-failed') throw startErr
        stage = failure.code === 'register-failed' ? 'register_session' : 'subscribe'
        const message = startErr instanceof Error ? startErr.message : String(startErr)
        console.error('[x-agent] invoke failed', { ...callerLog, targetSlug, stage, error: message })
        captureException(startErr, { tags: { ...X_AGENT_SENTRY, stage }, extra: { ...callerLog, targetSlug } })
        return fail(
          500,
          failure.code === 'register-failed'
            ? `Failed to register invoked session: ${message}`
            : `Failed to attach to invoked session: ${message}`,
        )
      }
      const newSessionId = containerSession.id
      if (initialMessageUuid && createdByUserId) {
        await insertMessageAuthorBestEffort({
          id: initialMessageUuid,
          sessionId: newSessionId,
          agentSlug: targetSlug,
          ...messageAuthorFields(caller, createdByUserId),
        })
      }
      // The x-agent provenance exists now: the target's trigger and history
      // UI can show the session at once instead of at its next poll.
      globalFeed.publish({ type: 'session_updated', sessionId: newSessionId, agentSlug: targetSlug })

      if (sync) {
        stage = 'wait_for_idle'
        let outcome: 'completed' | 'timeout'
        try {
          outcome = await waitForTurnWithinBudget(targetSlug, newSessionId, syncDeadline)
        } catch (error) {
          return { ok: true, value: {
            sessionId: newSessionId,
            status: 'running',
            error: error instanceof Error ? error.message : String(error),
          } }
        }
        if (outcome === 'timeout') {
          // Budget exhausted (whether before or during the wait) means the
          // target is simply still working — promote to the async contract
          // with explicit guidance so the caller polls instead of re-invoking
          // (a re-invoke duplicates the whole run).
          return { ok: true, value: {
            sessionId: newSessionId,
            status: 'running',
            error: syncWaitPromotedNote(syncWaitMs),
          } }
        }
        const lastMessage = await readLastAssistantMessage(targetSlug, newSessionId)
        return { ok: true, value: {
          sessionId: newSessionId,
          status: 'completed',
          lastMessage: lastMessage?.content,
        } }
      }
      return { ok: true, value: { sessionId: newSessionId, status: 'running' } }
    } catch (err) {
      if (!promptDeliveryStarted && stagedTargetFiles && stagedTargetDirectory) {
        await removeTransferredAttachments(stagedTargetFiles, stagedTargetDirectory).catch(() => {})
      }
      if (err instanceof XAgentAttachmentError) {
        return fail(err.status, err.message)
      }
      const message = err instanceof Error ? err.message : String(err)
      console.error('[x-agent] invoke failed', {
        ...callerLog,
        targetSlug,
        existingSessionId: existingSessionId ?? null,
        stage,
        error: message,
      })
      captureException(err, {
        tags: { ...X_AGENT_SENTRY, stage },
        extra: { ...callerLog, targetSlug, existingSessionId: existingSessionId ?? null },
      })
      return fail(500, `Failed to invoke agent (${stage}): ${message}`)
    }
  })
}
