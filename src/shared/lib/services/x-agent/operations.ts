/**
 * The cross-agent read operations: list agents, list a target's sessions, read
 * a session's transcript, open a delivered file. Each acts for an
 * {@link XAgentCaller} and returns what the caller gets, or the refusal with
 * the HTTP status the agent-facing routes have always answered it with.
 */
import { listAgents } from '@shared/lib/services/agent-service'
import { displaySlug } from '@shared/lib/utils/file-storage'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import {
  normalizeXAgentAttachmentPaths,
  openXAgentFile,
  transferError,
  XAgentAttachmentError,
} from '@shared/lib/services/x-agent-attachment-service'
import type { TranscriptView } from '@shared/lib/services/x-agent-transcript-view'
import {
  callerHasRoleOnTarget,
  callerVisibleAgentSlugs,
  checkCallerPolicy,
  startPolicyRead,
  startRead,
  type XAgentCaller,
} from './caller'
import { effectiveSyncWaitMs, readLastAssistantMessage, waitForTurnWithinBudget } from './sync-wait'

export type XAgentErrorStatus = 400 | 403 | 404 | 409 | 413 | 500 | 502 | 504

/** A refusal or failure, with the status the routes answer it with. */
export interface XAgentFailure {
  ok: false
  status: XAgentErrorStatus
  error: string
}

export type XAgentResult<T> = { ok: true; value: T } | XAgentFailure

export function fail(status: XAgentErrorStatus, error: string): XAgentFailure {
  return { ok: false, status, error }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

// ----------------------------------------------------------------------------
// list - agents visible to caller
// ----------------------------------------------------------------------------

export interface ListedAgent {
  slug: string
  name: string
  description: string | undefined
}

export async function listVisibleAgents(caller: XAgentCaller): Promise<XAgentResult<{ agents: ListedAgent[] }>> {
  const policy = await checkCallerPolicy(caller, 'list', null, 'all agents')
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  const visible = await callerVisibleAgentSlugs(caller)
  const all = await listAgents()
  const filtered = all
    // An agent lists the others, not itself.
    .filter((a) => caller.kind !== 'agent' || a.slug !== caller.agentSlug)
    .filter((a) => (visible ? visible.has(a.slug) : true))
    .map((a) => ({
      // Project the decorative display slug for the model; the catalog tolerates
      // it (and the bare id / legacy form) on the way back in via invoke/get-*.
      slug: displaySlug(a.name, a.slug),
      name: a.name,
      description: a.description,
    }))
  return ok({ agents: filtered })
}

// ----------------------------------------------------------------------------
// get-sessions - list sessions of a target agent
// ----------------------------------------------------------------------------

export interface ListedSession {
  id: string
  name: string
  createdAt: Date
  lastActivityAt: Date
  isRunning: boolean
}

export async function getTargetSessions(
  caller: XAgentCaller,
  input: { slug: string; limit: number; offset: number },
): Promise<XAgentResult<{ sessions: ListedSession[]; total: number; offset: number; limit: number }>> {
  const { slug: rawTargetSlug, limit, offset } = input

  // Resolve the model-supplied display slug to the agent and rebind, so every
  // downstream ACL / policy / fs use below keys on the id, not the prefix.
  const target = await agentCatalog.resolveRecord(rawTargetSlug)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug

  const access = startRead(callerHasRoleOnTarget(caller, targetSlug, 'viewer'))
  const savedDecision = startPolicyRead(caller, 'read', targetSlug)
  if (!(await access)) {
    return fail(403, 'Forbidden: caller has no access to target agent')
  }

  const policy = await checkCallerPolicy(caller, 'read', targetSlug, target.name, { savedDecision })
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  const actor = agentRegistry.get(targetSlug)
  const allSessions = await actor.sessions.list()
  const page = allSessions.slice(offset, offset + limit)
  const active = new Set((await actor.live()).activeSessionIds)
  return ok({
    sessions: page.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      isRunning: active.has(s.id),
    })),
    total: allSessions.length,
    offset,
    limit,
  })
}

// ----------------------------------------------------------------------------
// get-transcript - read transcript for a target session
// ----------------------------------------------------------------------------

export interface GetTranscriptInput {
  slug: string
  sessionId: string
  sync?: boolean
  // Most recent N view-rows. Omitted = the whole view.
  limit?: number
  // Default quiet: spoken turns, internals collapsed. true = today's compact view.
  fullTranscript?: boolean
  /**
   * How long a sync read may wait for a running turn, in ms. Clamped to
   * (0, the configured maximum]; absent = the maximum. Not on the agent route.
   */
  syncWaitMs?: number
}

export type TranscriptStatus = 'running' | 'idle' | 'awaiting_input'

export async function getTargetTranscript(
  caller: XAgentCaller,
  input: GetTranscriptInput,
): Promise<XAgentResult<{ status: TranscriptStatus } & TranscriptView>> {
  // Stamp the sync budget before any slow pre-work (policy review can block on
  // a human decision) so the total response time stays under the transport cap.
  const syncDeadline = Date.now() + effectiveSyncWaitMs(input.syncWaitMs)
  const { slug: rawTargetSlug, sessionId, sync, limit, fullTranscript } = input

  // Resolve the model-supplied display slug to the agent and rebind.
  const target = await agentCatalog.resolveRecord(rawTargetSlug)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug

  const access = startRead(callerHasRoleOnTarget(caller, targetSlug, 'viewer'))
  const savedDecision = startPolicyRead(caller, 'read', targetSlug)
  if (!(await access)) {
    return fail(403, 'Forbidden: caller has no access to target agent')
  }

  const policy = await checkCallerPolicy(caller, 'read', targetSlug, target.name, { savedDecision })
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  const actor = agentRegistry.get(targetSlug)

  // Status and wait state live in the target's live sessions. Validate the
  // target/session pair before consulting them, not only before reading the
  // target-scoped transcript below.
  if (!(await actor.sessions.isKnown(sessionId))) {
    return fail(404, 'Session not found')
  }

  if (sync && (await actor.sessions.live(sessionId)).isActive) {
    // Last reply flushed before we started waiting — used below to detect that
    // the turn we waited out has actually reached the transcript file.
    const boundaryEntry = await actor.messages.findLastEntry(sessionId, { kind: 'assistant' })
    try {
      // 'timeout' falls through: return the transcript so far with status
      // 'running'. Sync get-transcript is a bounded long-poll the caller can
      // repeat, not an unbounded wait — an unbounded wait would outlive the
      // container's 300s fetch header timeout and surface as a retry-inducing
      // network error. Other failures stay hard errors.
      const outcome = await waitForTurnWithinBudget(targetSlug, sessionId, syncDeadline)
      // The turn's 'result' event clears isActive before its final assistant
      // entry hits the JSONL file. When the turn we observed running has ended
      // — the wait said so, or it timed out and the turn ended in the gap
      // before the status read below — reconcile (bounded, ~5s) until an entry
      // newer than the pre-wait boundary appears, so an "idle" response
      // doesn't ship a transcript missing the reply it waited for.
      //
      // Deliberately gated on activity observed IN THIS REQUEST: the JSONL is
      // written by the container process, so the host has no write queue to
      // barrier on, and reconciling on every idle response would burn the full
      // poll budget on sessions that are simply idle. A session that went idle
      // just before the isSessionActive check above keeps plain read-what's-
      // flushed semantics.
      if (outcome === 'completed' || !(await actor.sessions.live(sessionId)).isActive) {
        await readLastAssistantMessage(targetSlug, sessionId, boundaryEntry?.uuid)
      }
    } catch (error) {
      return fail(504, `Session did not idle: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const live = await actor.sessions.live(sessionId)
  const status: TranscriptStatus = live.isAwaitingInput
    ? 'awaiting_input'
    : live.isActive
      ? 'running'
      : 'idle'

  const { messages, total, deliveredFiles } = await actor.messages.transcriptView(sessionId, { fullTranscript, limit })

  return ok({ status, messages, total, deliveredFiles })
}

// ----------------------------------------------------------------------------
// download-file - open a successful deliver_file output
// ----------------------------------------------------------------------------

export interface OpenedDeliveredFile {
  body: ReadableStream<Uint8Array>
  sizeBytes: number
  filename: string
}

export async function openDeliveredFile(
  caller: XAgentCaller,
  input: { slug: string; sessionId: string; deliveryId: string },
): Promise<XAgentResult<OpenedDeliveredFile>> {
  const { slug: rawTargetSlug, sessionId, deliveryId } = input
  const target = await agentCatalog.resolveRecord(rawTargetSlug)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug
  // The policy is read where it always was, after the delivery is found: that
  // lookup parses a transcript, and a Block saved meanwhile must still apply.
  if (!(await callerHasRoleOnTarget(caller, targetSlug, 'viewer'))) {
    return fail(403, 'Forbidden: caller has no access to target agent')
  }
  const actor = agentRegistry.get(targetSlug)
  if (!(await actor.sessions.isKnown(sessionId))) {
    return fail(404, 'Session not found')
  }

  const delivery = await actor.messages.findDeliveredFile(sessionId, deliveryId)
  if (!delivery) return fail(404, 'Delivered file not found')
  const policy = await checkCallerPolicy(caller, 'read', targetSlug, target.name, {
    fileTransfer: { kind: 'download', filename: delivery.filename },
  })
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  let sourcePath: string
  try {
    [sourcePath] = normalizeXAgentAttachmentPaths([delivery.filePath])
  } catch {
    return fail(400, 'Delivered file path is invalid')
  }
  try {
    const upstream = await openXAgentFile(actor.files, sourcePath)
    const currentSize = upstream.sizeBytes
    if (currentSize !== delivery.sizeBytes) {
      await upstream.body.cancel().catch(() => {})
      return fail(409, 'Delivered file changed after it was published')
    }
    return ok({ body: upstream.body, sizeBytes: currentSize, filename: delivery.filename })
  } catch (caught) {
    const error = transferError(caught)
    if (error instanceof XAgentAttachmentError) {
      return fail(error.status, error.status === 404 ? 'Delivered file is no longer available' : error.message)
    }
    return fail(502, 'Failed to read delivered file')
  }
}
