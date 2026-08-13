import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useMessages } from '@renderer/hooks/use-messages'
import { usePendingUserRequests } from '@renderer/hooks/use-pending-user-requests'
import { isTurnStartingUserMessage, type PendingMessage } from './pending-message'
import { computerUseMethodFromToolName, getRequiredPermissionLevel, resolveTargetApp } from '@shared/lib/computer-use/types'
import { askUserQuestionDef } from '@shared/lib/tool-definitions/ask-user-question'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'
import { toolCallHasResult } from '@shared/lib/types/api'

interface UsePendingRequestsArgs {
  sessionId: string
  agentSlug: string
  pendingUserMessages?: PendingMessage[]
}

type Question = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

type PendingRequestBuckets = {
  secretRequests: { toolUseId: string; secretName: string; reason?: string }[]
  connectedAccountRequests: { toolUseId: string; toolkit: string; reason?: string }[]
  questionRequests: { toolUseId: string; questions: Question[] }[]
  fileRequests: { toolUseId: string; description: string; fileTypes?: string }[]
  remoteMcpRequests: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[]
  browserInputRequests: { toolUseId: string; message: string; requirements: string[] }[]
  scriptRunRequests: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[]
  computerUseRequests: { toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }[]
}

type RequestToolCall = {
  id: string
  name: string
  input: unknown
}

function recordFromInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function createPendingRequestBuckets(): PendingRequestBuckets {
  return {
    secretRequests: [],
    connectedAccountRequests: [],
    questionRequests: [],
    fileRequests: [],
    remoteMcpRequests: [],
    browserInputRequests: [],
    scriptRunRequests: [],
    computerUseRequests: [],
  }
}

// The single merge rule the per-kind memos used to duplicate eight times:
// first occurrence of a toolUseId across the ordered sources wins, dismissed
// and suppressed ids never surface.
function mergeBucket<K extends keyof PendingRequestBuckets>(
  target: PendingRequestBuckets,
  kind: K,
  sources: Array<PendingRequestBuckets[K]>,
  dismissed: ReadonlySet<string>,
  suppressed?: ReadonlySet<string>,
): void {
  const seen = new Set<string>()
  const out = target[kind] as Array<PendingRequestBuckets[K][number]>
  for (const source of sources) {
    for (const req of source) {
      if (suppressed?.has(req.toolUseId)) continue
      if (seen.has(req.toolUseId) || dismissed.has(req.toolUseId)) continue
      seen.add(req.toolUseId)
      out.push(req)
    }
  }
}

function isScriptType(value: unknown): value is 'applescript' | 'shell' | 'powershell' {
  return value === 'applescript' || value === 'shell' || value === 'powershell'
}

function normalizePendingQuestions(input: Record<string, unknown>): Question[] {
  const questions = askUserQuestionDef.parseInput(input).questions
  if (!questions?.length) return []

  return questions.flatMap((question) => {
    if (typeof question.question !== 'string' || !question.question.trim()) return []

    return [{
      question: question.question,
      header: typeof question.header === 'string' ? question.header : '',
      options: Array.isArray(question.options)
        ? question.options.flatMap((option) => (
          typeof option.label === 'string'
            ? [{ label: option.label, description: typeof option.description === 'string' ? option.description : '' }]
            : []
        ))
        : [],
      multiSelect: question.multiSelect === true,
    }]
  })
}

function addPendingRequestFromToolCall(buckets: PendingRequestBuckets, toolCall: RequestToolCall) {
  const input = recordFromInput(toolCall.input)

  if (toolCall.name === 'mcp__user-input__request_secret') {
    if (typeof input.secretName === 'string') {
      buckets.secretRequests.push({
        toolUseId: toolCall.id,
        secretName: input.secretName,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
      })
    }
  } else if (toolCall.name === 'mcp__user-input__request_connected_account') {
    if (typeof input.toolkit === 'string') {
      buckets.connectedAccountRequests.push({
        toolUseId: toolCall.id,
        toolkit: input.toolkit,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
      })
    }
  } else if (toolCall.name === 'AskUserQuestion') {
    const questions = normalizePendingQuestions(input)
    if (questions.length) {
      buckets.questionRequests.push({
        toolUseId: toolCall.id,
        questions,
      })
    }
  } else if (toolCall.name === 'mcp__user-input__request_remote_mcp') {
    if (typeof input.url === 'string') {
      buckets.remoteMcpRequests.push({
        toolUseId: toolCall.id,
        url: input.url,
        name: typeof input.name === 'string' ? input.name : undefined,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        authHint: input.authHint === 'oauth' || input.authHint === 'bearer' ? input.authHint : undefined,
      })
    }
  } else if (toolCall.name === 'mcp__user-input__request_file') {
    if (typeof input.description === 'string') {
      buckets.fileRequests.push({
        toolUseId: toolCall.id,
        description: input.description,
        fileTypes: typeof input.fileTypes === 'string' ? input.fileTypes : undefined,
      })
    }
  } else if (toolCall.name === 'mcp__user-input__request_browser_input') {
    if (typeof input.message === 'string') {
      buckets.browserInputRequests.push({
        toolUseId: toolCall.id,
        message: input.message,
        // Model-controlled: coerce a non-array (e.g. a bare string) to []
        // so downstream `.map()` can't crash the request card. `|| []`
        // would let a non-empty string through.
        requirements: Array.isArray(input.requirements) ? input.requirements : [],
      })
    }
  } else if (toolCall.name === 'mcp__user-input__request_script_run') {
    if (typeof input.script === 'string' && isScriptType(input.scriptType)) {
      buckets.scriptRunRequests.push({
        toolUseId: toolCall.id,
        script: input.script,
        explanation: typeof input.explanation === 'string' ? input.explanation : '',
        scriptType: input.scriptType,
      })
    }
  } else if (toolCall.name.startsWith('mcp__computer-use__computer_')) {
    const method = computerUseMethodFromToolName(toolCall.name)
    buckets.computerUseRequests.push({
      toolUseId: toolCall.id,
      method,
      params: input,
      permissionLevel: getRequiredPermissionLevel(method),
      appName: resolveTargetApp(method, input),
    })
  }
}

type UnifiedCapabilityReview = {
  toolUseId: string
  capability: 'subagents' | 'workflows'
  toolName: string
  input: Record<string, unknown>
}

interface UnifiedProjection {
  buckets: PendingRequestBuckets
  capabilityReviews: UnifiedCapabilityReview[]
  reviews: PendingReview[]
  accountReauthRequests: PendingAccountReauth[]
  mcpReauthRequests: PendingMcpReauth[]
  /**
   * Ids the server auto-approved and is ALREADY executing, per suppressible
   * kind. They are deliberately absent from the buckets — no card is owed for
   * them — but they must still be suppressed, because the streaming and
   * message-history fallbacks recover the same tool call from the transcript
   * and would draw an approval card for work already in flight. Pressing it
   * races the internal `_auto` call and can run the side effect twice.
   *
   * This is the reconnect-safe half of the suppression: the live
   * `user_request_created` event is one-shot, so a client that mounts after it
   * fired has nothing in its live set and only the snapshot still knows.
   */
  autoApprovedScriptRunIds: Set<string>
  autoApprovedComputerUseIds: Set<string>
}

function isXAgentOperation(value: unknown): value is 'list' | 'read' | 'invoke' | 'create' {
  return value === 'list' || value === 'read' || value === 'invoke' || value === 'create'
}

/**
 * A proxy / x-agent review as the cards render it. Formerly the response shape
 * of the `proxy-reviews` poll; now purely the projection of a review envelope,
 * which is the only source left.
 */
export interface PendingReview {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  displayText?: string
  xAgent?: {
    targetAgentSlug: string
    targetAgentName: string
    operation: 'list' | 'read' | 'invoke' | 'create'
    preview?: string
  }
}

export interface PendingAccountReauth {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  accountStatus: 'expired' | 'revoked'
  proxyRequestId: string
}

export interface PendingMcpReauth {
  id: string
  agentSlug: string
  mcpId: string
  mcpName: string
  authType: 'none' | 'oauth' | 'bearer'
  proxyRequestId: string
}

export function accountReauthFromEnvelope(
  request: PendingUserInputRequest,
  payload: Record<string, unknown>,
): PendingAccountReauth | null {
  if (
    request.kind !== 'account_reauth_required' ||
    typeof payload.accountId !== 'string' ||
    typeof payload.toolkit !== 'string' ||
    (payload.accountStatus !== 'expired' && payload.accountStatus !== 'revoked')
  ) {
    return null
  }
  return {
    id: request.id,
    agentSlug: request.scope.agentSlug ?? '',
    accountId: payload.accountId,
    toolkit: payload.toolkit,
    accountStatus: payload.accountStatus,
    proxyRequestId:
      typeof payload.proxyRequestId === 'string' ? payload.proxyRequestId : request.id,
  }
}

export function mcpReauthFromEnvelope(
  request: PendingUserInputRequest,
  payload: Record<string, unknown>,
): PendingMcpReauth | null {
  if (
    request.kind !== 'mcp_reauth_required' ||
    typeof payload.mcpId !== 'string' ||
    typeof payload.mcpName !== 'string' ||
    (payload.authType !== 'none' && payload.authType !== 'oauth' && payload.authType !== 'bearer')
  ) {
    return null
  }
  return {
    id: request.id,
    agentSlug: request.scope.agentSlug ?? '',
    mcpId: payload.mcpId,
    mcpName: payload.mcpName,
    authType: payload.authType,
    proxyRequestId:
      typeof payload.proxyRequestId === 'string' ? payload.proxyRequestId : request.id,
  }
}

// Rebuild the PendingReview shape from a review envelope. The payload carries
// the full ReviewDetails (plus the derived displayText), but envelope payloads
// are lenient by design, so the card-critical fields are re-validated here
// instead of trusted. Exported for the dashboard's pending-reviews panel,
// which reads the same snapshot.
export function reviewFromEnvelope(
  request: PendingUserInputRequest,
  payload: Record<string, unknown>,
): PendingReview | null {
  if (
    typeof payload.accountId !== 'string' ||
    typeof payload.toolkit !== 'string' ||
    typeof payload.method !== 'string' ||
    typeof payload.targetPath !== 'string'
  ) {
    return null
  }
  let xAgent: PendingReview['xAgent']
  if (request.kind === 'x_agent_review') {
    const raw = payload.xAgent as Record<string, unknown> | undefined
    if (
      !raw ||
      typeof raw.targetAgentSlug !== 'string' ||
      typeof raw.targetAgentName !== 'string' ||
      !isXAgentOperation(raw.operation)
    ) {
      return null
    }
    xAgent = {
      targetAgentSlug: raw.targetAgentSlug,
      targetAgentName: raw.targetAgentName,
      operation: raw.operation,
      preview: typeof raw.preview === 'string' ? raw.preview : undefined,
    }
  }
  return {
    id: request.id,
    agentSlug: request.scope.agentSlug ?? '',
    accountId: payload.accountId,
    toolkit: payload.toolkit,
    method: payload.method,
    targetPath: payload.targetPath,
    matchedScopes: Array.isArray(payload.matchedScopes)
      ? payload.matchedScopes.filter((s): s is string => typeof s === 'string')
      : [],
    scopeDescriptions:
      payload.scopeDescriptions && typeof payload.scopeDescriptions === 'object' && !Array.isArray(payload.scopeDescriptions)
        ? (payload.scopeDescriptions as Record<string, string>)
        : {},
    displayText: typeof payload.displayText === 'string' ? payload.displayText : undefined,
    ...(xAgent ? { xAgent } : {}),
  }
}

// Project unified registry envelopes onto the same per-kind shapes the legacy
// SSE events carried, so the descriptor builder (and every card) is untouched
// by the wire migration. Envelope payloads are lenient by design (the server
// keeps a wait alive even for malformed tool input), so each kind re-applies
// the exact guards the legacy handlers used before rendering.
function projectUnifiedRequests(requests: PendingUserInputRequest[]): UnifiedProjection {
  const buckets = createPendingRequestBuckets()
  const capabilityReviews: UnifiedCapabilityReview[] = []
  const reviews: PendingReview[] = []
  const accountReauthRequests: PendingAccountReauth[] = []
  const mcpReauthRequests: PendingMcpReauth[] = []
  const autoApprovedScriptRunIds = new Set<string>()
  const autoApprovedComputerUseIds = new Set<string>()

  for (const request of requests) {
    const payload = request.payload as Record<string, unknown>
    switch (request.kind) {
      case 'secret':
        if (typeof payload.secretName === 'string') {
          buckets.secretRequests.push({
            toolUseId: request.id,
            secretName: payload.secretName,
            reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          })
        }
        break
      case 'connected_account':
        if (typeof payload.toolkit === 'string') {
          buckets.connectedAccountRequests.push({
            toolUseId: request.id,
            toolkit: payload.toolkit,
            reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          })
        }
        break
      case 'question': {
        // Same normalizer as the message-history path: the card indexes
        // options unconditionally, and this bucket wins the dedupe — a raw
        // passthrough would crash the card with no reload escape.
        const questions = normalizePendingQuestions(payload)
        if (questions.length) {
          buckets.questionRequests.push({
            toolUseId: request.id,
            questions,
          })
        }
        break
      }
      case 'file':
        if (typeof payload.description === 'string') {
          buckets.fileRequests.push({
            toolUseId: request.id,
            description: payload.description,
            fileTypes: typeof payload.fileTypes === 'string' ? payload.fileTypes : undefined,
          })
        }
        break
      case 'remote_mcp':
        if (typeof payload.url === 'string') {
          buckets.remoteMcpRequests.push({
            toolUseId: request.id,
            url: payload.url,
            name: typeof payload.name === 'string' ? payload.name : undefined,
            reason: typeof payload.reason === 'string' ? payload.reason : undefined,
            authHint: payload.authHint === 'oauth' || payload.authHint === 'bearer' ? payload.authHint : undefined,
          })
        }
        break
      case 'browser_input':
        if (typeof payload.message === 'string') {
          buckets.browserInputRequests.push({
            toolUseId: request.id,
            message: payload.message,
            requirements: Array.isArray(payload.requirements) ? payload.requirements : [],
          })
        }
        break
      case 'script_run':
        // Auto-approved scripts are already executing server-side; the entry
        // exists so recovery paths can tell "granted" from "waiting".
        if (request.autoApproved) {
          autoApprovedScriptRunIds.add(request.id)
          break
        }
        if (typeof payload.script === 'string' && isScriptType(payload.scriptType)) {
          buckets.scriptRunRequests.push({
            toolUseId: request.id,
            script: payload.script,
            explanation: typeof payload.explanation === 'string' ? payload.explanation : '',
            scriptType: payload.scriptType,
          })
        }
        break
      case 'computer_use':
        if (request.autoApproved) {
          autoApprovedComputerUseIds.add(request.id)
          break
        }
        if (typeof payload.method === 'string' && typeof payload.permissionLevel === 'string') {
          buckets.computerUseRequests.push({
            toolUseId: request.id,
            method: payload.method,
            params:
              payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
                ? (payload.params as Record<string, unknown>)
                : {},
            permissionLevel: payload.permissionLevel,
            appName: typeof payload.appName === 'string' ? payload.appName : undefined,
          })
        }
        break
      case 'capability_review':
        if (
          (payload.capability === 'subagents' || payload.capability === 'workflows') &&
          typeof payload.toolName === 'string'
        ) {
          capabilityReviews.push({
            toolUseId: request.id,
            capability: payload.capability,
            toolName: payload.toolName,
            input: recordFromInput(payload.input),
          })
        }
        break
      case 'proxy_review':
      case 'x_agent_review': {
        const review = reviewFromEnvelope(request, payload)
        if (review) reviews.push(review)
        break
      }
      case 'account_reauth_required':
        {
          const reauth = accountReauthFromEnvelope(request, payload)
          if (reauth) accountReauthRequests.push(reauth)
        }
        break
      case 'mcp_reauth_required':
        {
          const reauth = mcpReauthFromEnvelope(request, payload)
          if (reauth) mcpReauthRequests.push(reauth)
        }
        break
    }
  }

  return {
    buckets,
    capabilityReviews,
    reviews,
    accountReauthRequests,
    mcpReauthRequests,
    autoApprovedScriptRunIds,
    autoApprovedComputerUseIds,
  }
}

/**
 * The browser tray's view of open browser_input requests.
 *
 * Reads the same unified snapshot the in-chat cards project from, so a request
 * the registry recovered — or one settled on another surface — reaches the tray
 * too. The tradeoff is timing: the overlay appears one snapshot refetch after
 * the created event rather than synchronously with it.
 */
export function usePendingBrowserInputRequests(
  sessionId: string,
  agentSlug: string,
  isActive: boolean,
): {
  requests: PendingRequestBuckets['browserInputRequests']
  dismiss: (toolUseId: string) => void
} {
  const { data } = usePendingUserRequests(agentSlug, sessionId)
  // Local dismissal, same reason as the request stack's: answering in the tray
  // must drop the overlay now, not one server round trip later.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const dismiss = useCallback((toolUseId: string) => {
    setDismissed((prev) => new Set(prev).add(toolUseId))
  }, [])

  const prevIsActive = useRef(isActive)
  useEffect(() => {
    if (prevIsActive.current && !isActive) setDismissed(new Set())
    prevIsActive.current = isActive
  }, [isActive])

  const requests = useMemo(() => {
    // Session-scoped waits die with the turn, matching the array this replaced
    // (session_idle and session_error both emptied it).
    if (!isActive) return []
    return projectUnifiedRequests(data ?? []).buckets.browserInputRequests.filter(
      (r) => !dismissed.has(r.toolUseId),
    )
  }, [data, isActive, dismissed])

  return { requests, dismiss }
}

export type PendingRequestDescriptor =
  | { kind: 'secret'; key: string; toolUseId: string; secretName: string; reason?: string; onComplete: () => void }
  | { kind: 'connected_account'; key: string; toolUseId: string; toolkit: string; reason?: string; onComplete: () => void }
  | { kind: 'remote_mcp'; key: string; toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer'; onComplete: () => void }
  | { kind: 'question'; key: string; toolUseId: string; questions: Question[]; onComplete: () => void }
  | { kind: 'file'; key: string; toolUseId: string; description: string; fileTypes?: string; onComplete: () => void }
  | { kind: 'browser_input'; key: string; toolUseId: string; message: string; requirements: string[]; onComplete: () => void }
  | { kind: 'script_run'; key: string; toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell'; onComplete: () => void }
  | { kind: 'computer_use'; key: string; toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; onComplete: () => void }
  | { kind: 'capability_review'; key: string; toolUseId: string; capability: 'subagents' | 'workflows'; toolName: string; input: Record<string, unknown>; onComplete: () => void }
  | { kind: 'proxy_review'; key: string; reviewId: string; accountId: string; toolkit: string; method: string; targetPath: string; matchedScopes: string[]; scopeDescriptions: Record<string, string>; displayText?: string; onComplete: () => void }
  | { kind: 'x_agent_review'; key: string; reviewId: string; xAgent: NonNullable<PendingReview['xAgent']>; onComplete: () => void }
  | { kind: 'account_reauth_required'; key: string; proxyRequestId: string; accountId: string; toolkit: string; accountStatus: 'expired' | 'revoked'; onComplete: () => void }
  | { kind: 'mcp_reauth_required'; key: string; proxyRequestId: string; mcpId: string; mcpName: string; authType: 'none' | 'oauth' | 'bearer'; onComplete: () => void }

interface UsePendingRequestsResult {
  items: PendingRequestDescriptor[]
  count: number
}

export function usePendingRequests({
  sessionId,
  agentSlug,
  pendingUserMessages,
}: UsePendingRequestsArgs): UsePendingRequestsResult {
  // Only turn-starting sends mean the user "moved past" a request; queued
  // (mid-turn) messages leave the agent blocked on it.
  const hasPendingUserMessage = !!pendingUserMessages?.some((p) => !p.queued)
  const queryClient = useQueryClient()
  const { data: messages } = useMessages(sessionId, agentSlug)
  const {
    isActive,
    streamingToolUses,
    autoApprovedScriptRunIds,
    autoApprovedComputerUseIds,
  } = useMessageStream(sessionId, agentSlug)

  // The snapshot is the only source for reviews and capability reviews, and
  // the primary one for every other kind. The streaming/message-history
  // fallbacks below cover the transcript-recovery path: recovered entries are
  // in the snapshot but carry no payload, so the per-kind guards drop them and
  // the transcript is what renders them.
  const { data: unifiedRequestsData } = usePendingUserRequests(agentSlug, sessionId)
  const unified = useMemo(() => {
    const requests = unifiedRequestsData ?? []
    // Session-scoped waits die with the turn for DISPLAY purposes — the legacy
    // arrays were cleared on session_idle, and e.g. an abandoned computer-use
    // approval deliberately survives the idle boundary server-side for
    // reconnect replay. Rendering it on an idle session would gate the
    // composer behind a dead card. Agent-scoped reviews render regardless:
    // they outlive any one turn.
    return projectUnifiedRequests(
      isActive ? requests : requests.filter((r) => r.scope.sessionId === undefined),
    )
  }, [unifiedRequestsData, isActive])
  const pendingProxyReviews = unified.reviews
  const pendingAccountReauthRequests = unified.accountReauthRequests
  const pendingMcpReauthRequests = unified.mcpReauthRequests

  // Derive pending requests from message history (for page refresh recovery).
  // Tool calls without a result are still pending, but only if there are no
  // subsequent user messages (which would indicate user has moved past the request).
  const messagesBasedPendingRequests = useMemo(() => {
    const buckets = createPendingRequestBuckets()

    if (!messages) return buckets

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.type !== 'assistant') continue

      // Queued (mid-turn) messages don't count — the agent hasn't moved past
      // the request; it stays blocked until the request is answered.
      const hasSubsequentUserMessage =
        hasPendingUserMessage || messages.slice(i + 1).some(isTurnStartingUserMessage)
      if (hasSubsequentUserMessage) continue

      for (const toolCall of message.toolCalls) {
        if (toolCallHasResult(toolCall)) continue
        addPendingRequestFromToolCall(buckets, toolCall)
      }
    }

    return buckets
  }, [messages, hasPendingUserMessage])

  // Derive pending requests from ready in-flight tool calls too. This closes the
  // gap where the one-shot request SSE event is missed but the tool call has not
  // reached the persisted message-history fallback yet.
  const streamingBasedPendingRequests = useMemo(() => {
    const buckets = createPendingRequestBuckets()

    for (const toolUse of streamingToolUses) {
      if (!toolUse.ready) continue

      try {
        addPendingRequestFromToolCall(buckets, {
          id: toolUse.id,
          name: toolUse.name,
          input: JSON.parse(toolUse.partialInput || '{}'),
        })
      } catch {
        // The ready event should mean parseable input, but skip defensively
        // rather than risking a render crash from malformed streaming data.
      }
    }

    return buckets
  }, [streamingToolUses])

  // Track toolUseIds the user has already answered, so no source re-surfaces
  // them before the settlement lands. State (not a ref): the merge memos
  // filter on this set, and completion must recompute them SYNCHRONOUSLY —
  // an answered card leaves the stack immediately, not a server round trip
  // later when the store refetch settles it.
  const [dismissedRequestIds, setDismissedRequestIds] = useState<ReadonlySet<string>>(new Set())
  const dismissRequest = useCallback((toolUseId: string) => {
    setDismissedRequestIds((prev) => new Set(prev).add(toolUseId))
  }, [])

  // Clear dismissed set when session transitions from active → idle.
  const prevIsActive = useRef(isActive)
  useEffect(() => {
    if (prevIsActive.current && !isActive) {
      setDismissedRequestIds(new Set())
    }
    prevIsActive.current = isActive
  }, [isActive])

  // One merge rule for every bucket kind: unified snapshot ∪ streaming
  // fallback ∪ message-history fallback, first occurrence of a toolUseId
  // wins, dismissed ids drop, and the auto-approved suppress-set (script_run
  // and computer_use only) hides requests the server is already executing.
  // Live event ∪ snapshot. The live sets are written synchronously by
  // user_request_created (they have to be, to beat the fallback-card flash),
  // but that event is one-shot: a client that mounts or reconnects after it
  // fired only learns from the snapshot. Without the union, the transcript
  // fallback revives an approval card for a request already executing.
  const suppressedScriptRunIds = useMemo(
    () => new Set([...autoApprovedScriptRunIds, ...unified.autoApprovedScriptRunIds]),
    [autoApprovedScriptRunIds, unified.autoApprovedScriptRunIds],
  )
  const suppressedComputerUseIds = useMemo(
    () => new Set([...autoApprovedComputerUseIds, ...unified.autoApprovedComputerUseIds]),
    [autoApprovedComputerUseIds, unified.autoApprovedComputerUseIds],
  )

  const merged = useMemo(() => {
    const target = createPendingRequestBuckets()
    for (const kind of Object.keys(target) as Array<keyof PendingRequestBuckets>) {
      const suppressed =
        kind === 'scriptRunRequests'
          ? suppressedScriptRunIds
          : kind === 'computerUseRequests'
            ? suppressedComputerUseIds
            : undefined
      mergeBucket(
        target,
        kind,
        // The fallbacks recover only ACTIVE turns — an idle session's
        // unanswered tool calls are history, not open requests.
        isActive
          ? [unified.buckets[kind], streamingBasedPendingRequests[kind], messagesBasedPendingRequests[kind]]
          : [unified.buckets[kind]],
        dismissedRequestIds,
        suppressed,
      )
    }
    return target
  }, [
    unified.buckets, streamingBasedPendingRequests, messagesBasedPendingRequests,
    isActive, suppressedScriptRunIds, suppressedComputerUseIds, dismissedRequestIds,
  ])

  // Capability reviews come from the unified store only — no message-history
  // or streaming recovery. A Task/Workflow call without a result usually means
  // the launch is RUNNING (allow policy or an active session grant), not
  // awaiting approval; only the host registry knows which. A cold mount
  // therefore shows the card one snapshot fetch late.
  const pendingCapabilityReviewRequests = useMemo(() => {
    if (!isActive) return []
    return unified.capabilityReviews.filter((r) => !dismissedRequestIds.has(r.toolUseId))
  }, [unified.capabilityReviews, isActive, dismissedRequestIds])

  // Track arrival order so the stack is chronological. Each id gets a
  // monotonically increasing sequence number the first time it appears.
  const arrivalOrder = useRef(new Map<string, number>())
  const arrivalSeq = useRef(0)

  const allPendingIds = useMemo(() => {
    const ids: string[] = []
    for (const arr of [
      merged.secretRequests,
      merged.connectedAccountRequests,
      merged.remoteMcpRequests,
      merged.questionRequests,
      merged.fileRequests,
      merged.browserInputRequests,
      merged.scriptRunRequests,
      merged.computerUseRequests,
      pendingCapabilityReviewRequests,
    ]) {
      for (const req of arr) ids.push(req.toolUseId)
    }
    for (const review of pendingProxyReviews) ids.push(review.id)
    for (const request of pendingAccountReauthRequests) ids.push(request.id)
    for (const request of pendingMcpReauthRequests) ids.push(request.id)
    return ids
  }, [
    merged.secretRequests, merged.connectedAccountRequests, merged.remoteMcpRequests,
    merged.questionRequests, merged.fileRequests, merged.browserInputRequests,
    merged.scriptRunRequests, merged.computerUseRequests, pendingCapabilityReviewRequests, pendingProxyReviews,
    pendingAccountReauthRequests,
    pendingMcpReauthRequests,
  ])

  // Effect — not useMemo — because we mutate refs. useMemo may re-run for the
  // same input (StrictMode, suspense, cache eviction) which would double-bump
  // arrivalSeq and break ordering.
  useEffect(() => {
    const currentIds = new Set(allPendingIds)
    for (const id of allPendingIds) {
      if (!arrivalOrder.current.has(id)) {
        arrivalOrder.current.set(id, arrivalSeq.current++)
      }
    }
    for (const id of arrivalOrder.current.keys()) {
      if (!currentIds.has(id)) arrivalOrder.current.delete(id)
    }
  }, [allPendingIds])

  const getArrivalOrder = useCallback((id: string) => {
    return arrivalOrder.current.get(id) ?? Infinity
  }, [])

  const handleRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
  }, [dismissRequest])

  const handleProxyReviewComplete = useCallback(() => {
    // The decision routes settle the registry entry, which broadcasts
    // user_request_resolved → this invalidation is the immediate local echo.
    queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
  }, [queryClient])

  const items = useMemo<PendingRequestDescriptor[]>(() => {
    const all: PendingRequestDescriptor[] = []
    for (const r of merged.secretRequests) {
      all.push({
        kind: 'secret',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        secretName: r.secretName,
        reason: r.reason,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.connectedAccountRequests) {
      all.push({
        kind: 'connected_account',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        toolkit: r.toolkit,
        reason: r.reason,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.remoteMcpRequests) {
      all.push({
        kind: 'remote_mcp',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        url: r.url,
        name: r.name,
        reason: r.reason,
        authHint: r.authHint,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.questionRequests) {
      all.push({
        kind: 'question',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        questions: r.questions,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.fileRequests) {
      all.push({
        kind: 'file',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        description: r.description,
        fileTypes: r.fileTypes,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.browserInputRequests) {
      all.push({
        kind: 'browser_input',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        message: r.message,
        requirements: r.requirements,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.scriptRunRequests) {
      all.push({
        kind: 'script_run',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        script: r.script,
        explanation: r.explanation,
        scriptType: r.scriptType,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of merged.computerUseRequests) {
      all.push({
        kind: 'computer_use',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        method: r.method,
        params: r.params,
        permissionLevel: r.permissionLevel,
        appName: r.appName,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingCapabilityReviewRequests) {
      all.push({
        kind: 'capability_review',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        capability: r.capability,
        toolName: r.toolName,
        input: r.input,
        onComplete: () => handleRequestComplete(r.toolUseId),
      })
    }
    for (const review of pendingProxyReviews) {
      if (review.xAgent) {
        all.push({
          kind: 'x_agent_review',
          key: review.id,
          reviewId: review.id,
          xAgent: review.xAgent,
          onComplete: handleProxyReviewComplete,
        })
      } else {
        all.push({
          kind: 'proxy_review',
          key: review.id,
          reviewId: review.id,
          accountId: review.accountId,
          toolkit: review.toolkit,
          method: review.method,
          targetPath: review.targetPath,
          matchedScopes: review.matchedScopes,
          scopeDescriptions: review.scopeDescriptions,
          displayText: review.displayText,
          onComplete: handleProxyReviewComplete,
        })
      }
    }
    for (const request of pendingAccountReauthRequests) {
      all.push({
        kind: 'account_reauth_required',
        key: request.id,
        proxyRequestId: request.proxyRequestId,
        accountId: request.accountId,
        toolkit: request.toolkit,
        accountStatus: request.accountStatus,
        onComplete: handleProxyReviewComplete,
      })
    }
    for (const request of pendingMcpReauthRequests) {
      all.push({
        kind: 'mcp_reauth_required',
        key: request.id,
        proxyRequestId: request.proxyRequestId,
        mcpId: request.mcpId,
        mcpName: request.mcpName,
        authType: request.authType,
        onComplete: handleProxyReviewComplete,
      })
    }
    return all.sort((a, b) => getArrivalOrder(a.key) - getArrivalOrder(b.key))
  }, [
    merged.secretRequests, merged.connectedAccountRequests, merged.remoteMcpRequests,
    merged.questionRequests, merged.fileRequests, merged.browserInputRequests,
    merged.scriptRunRequests, merged.computerUseRequests, pendingCapabilityReviewRequests, pendingProxyReviews,
    pendingAccountReauthRequests,
    pendingMcpReauthRequests,
    getArrivalOrder, handleRequestComplete, handleProxyReviewComplete,
  ])

  return { items, count: items.length }
}
