import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useMessageStream,
  removeSecretRequest,
  removeConnectedAccountRequest,
  removeRemoteMcpRequest,
  removeQuestionRequest,
  removeFileRequest,
  removeBrowserInputRequest,
  removeScriptRunRequest,
  removeComputerUseRequest,
  removeCapabilityReviewRequest,
} from '@renderer/hooks/use-message-stream'
import { useMessages } from '@renderer/hooks/use-messages'
import { usePendingUserRequests } from '@renderer/hooks/use-pending-user-requests'
import { usePendingProxyReviews, type PendingReview } from '@renderer/hooks/use-proxy-reviews'
import { isTurnStartingUserMessage, type PendingMessage } from './pending-message'
import { computerUseMethodFromToolName, getRequiredPermissionLevel, resolveTargetApp } from '@shared/lib/computer-use/types'
import { askUserQuestionDef } from '@shared/lib/tool-definitions/ask-user-question'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'

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
}

function isXAgentOperation(value: unknown): value is 'list' | 'read' | 'invoke' | 'create' {
  return value === 'list' || value === 'read' || value === 'invoke' || value === 'create'
}

// Rebuild the legacy poll's PendingReview shape from a review envelope. The
// payload carries the full ReviewDetails (plus the derived displayText), but
// envelope payloads are lenient by design, so the card-critical fields are
// re-validated here instead of trusted.
function reviewFromEnvelope(
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
        if (request.autoApproved) break
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
        if (request.autoApproved) break
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
    }
  }

  return { buckets, capabilityReviews, reviews }
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
    pendingCapabilityReviewRequests: sseCapabilityReviewRequests,
    streamingToolUses,
    autoApprovedScriptRunIds,
    autoApprovedComputerUseIds,
  } = useMessageStream(sessionId, agentSlug)

  // The unified store is the primary source for every kind — session-scoped
  // requests AND the agent-scoped reviews that used to arrive on a separate
  // poll. The streaming/message-history fallbacks below still cover the
  // transcript-recovery path (recovered entries are in the snapshot but carry
  // no payload, so the per-kind guards drop them; the transcript renders them).
  const { data: unifiedRequestsData } = usePendingUserRequests(agentSlug, sessionId)
  // undefined = the snapshot has NEVER succeeded (still in flight, or a cold
  // fetch failure with nothing cached) — distinct from a successful empty [].
  // Reviews have no message-history or streaming recovery, so until the first
  // snapshot lands the legacy poll and stream arrays below keep those cards
  // actionable; once a snapshot exists it is authoritative.
  const hasSnapshot = unifiedRequestsData !== undefined
  const { data: legacyProxyReviewsData } = usePendingProxyReviews(agentSlug)
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
  const pendingProxyReviews = useMemo(
    () => (hasSnapshot ? unified.reviews : legacyProxyReviewsData?.reviews ?? []),
    [hasSnapshot, unified.reviews, legacyProxyReviewsData],
  )

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
        if (toolCall.result !== undefined) continue
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

  // TODO: currently request handling is super duplicative for different types
  // (question, browser, permission, ...) — need to unify into a single helper.
  // Tracked: SUP-163.
  const pendingSecretRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; secretName: string; reason?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.secretRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.secretRequests : []
    for (const req of [...unified.buckets.secretRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.secretRequests, streamingBasedPendingRequests.secretRequests, messagesBasedPendingRequests.secretRequests, isActive, dismissedRequestIds])

  const pendingConnectedAccountRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; toolkit: string; reason?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.connectedAccountRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.connectedAccountRequests : []
    for (const req of [...unified.buckets.connectedAccountRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.connectedAccountRequests, streamingBasedPendingRequests.connectedAccountRequests, messagesBasedPendingRequests.connectedAccountRequests, isActive, dismissedRequestIds])

  const pendingQuestionRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; questions: Question[] }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.questionRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.questionRequests : []
    for (const req of [...unified.buckets.questionRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.questionRequests, streamingBasedPendingRequests.questionRequests, messagesBasedPendingRequests.questionRequests, isActive, dismissedRequestIds])

  const pendingFileRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; description: string; fileTypes?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.fileRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.fileRequests : []
    for (const req of [...unified.buckets.fileRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.fileRequests, streamingBasedPendingRequests.fileRequests, messagesBasedPendingRequests.fileRequests, isActive, dismissedRequestIds])

  const pendingRemoteMcpRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.remoteMcpRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.remoteMcpRequests : []
    for (const req of [...unified.buckets.remoteMcpRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.remoteMcpRequests, streamingBasedPendingRequests.remoteMcpRequests, messagesBasedPendingRequests.remoteMcpRequests, isActive, dismissedRequestIds])

  const pendingBrowserInputRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; message: string; requirements: string[] }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.browserInputRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.browserInputRequests : []
    for (const req of [...unified.buckets.browserInputRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.browserInputRequests, streamingBasedPendingRequests.browserInputRequests, messagesBasedPendingRequests.browserInputRequests, isActive, dismissedRequestIds])

  const pendingScriptRunRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.scriptRunRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.scriptRunRequests : []
    for (const req of [...unified.buckets.scriptRunRequests, ...streamingBased, ...messageBased]) {
      if (autoApprovedScriptRunIds.has(req.toolUseId)) continue
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.scriptRunRequests, streamingBasedPendingRequests.scriptRunRequests, messagesBasedPendingRequests.scriptRunRequests, isActive, autoApprovedScriptRunIds, dismissedRequestIds])

  const pendingComputerUseRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.computerUseRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.computerUseRequests : []
    for (const req of [...unified.buckets.computerUseRequests, ...streamingBased, ...messageBased]) {
      if (autoApprovedComputerUseIds.has(req.toolUseId)) continue
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [unified.buckets.computerUseRequests, streamingBasedPendingRequests.computerUseRequests, messagesBasedPendingRequests.computerUseRequests, isActive, autoApprovedComputerUseIds, dismissedRequestIds])

  // Capability reviews come from the unified store (with the stream source as
  // the cold-start fallback) — no message-history or streaming recovery. A
  // Task/Workflow call without a result usually means the launch is RUNNING
  // (allow policy or an active session grant), not awaiting approval; only
  // the host registry knows which.
  const pendingCapabilityReviewRequests = useMemo(() => {
    if (!isActive) return []
    const source = hasSnapshot ? unified.capabilityReviews : sseCapabilityReviewRequests
    return source.filter((r) => !dismissedRequestIds.has(r.toolUseId))
  }, [unified.capabilityReviews, sseCapabilityReviewRequests, hasSnapshot, isActive, dismissedRequestIds])

  // Track arrival order so the stack is chronological. Each id gets a
  // monotonically increasing sequence number the first time it appears.
  const arrivalOrder = useRef(new Map<string, number>())
  const arrivalSeq = useRef(0)

  const allPendingIds = useMemo(() => {
    const ids: string[] = []
    for (const arr of [
      pendingSecretRequests,
      pendingConnectedAccountRequests,
      pendingRemoteMcpRequests,
      pendingQuestionRequests,
      pendingFileRequests,
      pendingBrowserInputRequests,
      pendingScriptRunRequests,
      pendingComputerUseRequests,
      pendingCapabilityReviewRequests,
    ]) {
      for (const req of arr) ids.push(req.toolUseId)
    }
    for (const review of pendingProxyReviews) ids.push(review.id)
    return ids
  }, [
    pendingSecretRequests, pendingConnectedAccountRequests, pendingRemoteMcpRequests,
    pendingQuestionRequests, pendingFileRequests, pendingBrowserInputRequests,
    pendingScriptRunRequests, pendingComputerUseRequests, pendingCapabilityReviewRequests, pendingProxyReviews,
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

  const handleSecretRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeSecretRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleConnectedAccountRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeConnectedAccountRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleQuestionRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeQuestionRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleRemoteMcpRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeRemoteMcpRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleFileRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeFileRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleScriptRunRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeScriptRunRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleComputerUseRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeComputerUseRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleBrowserInputRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeBrowserInputRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleCapabilityReviewRequestComplete = useCallback((toolUseId: string) => {
    dismissRequest(toolUseId)
    removeCapabilityReviewRequest(sessionId, toolUseId)
  }, [sessionId, dismissRequest])

  const handleProxyReviewComplete = useCallback(() => {
    // The decision routes settle the registry entry, which broadcasts
    // user_request_resolved → this invalidation is the immediate local echo
    // (and keeps the dashboard's legacy review poll coherent).
    queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
    queryClient.invalidateQueries({ queryKey: ['proxy-reviews'] })
  }, [queryClient])

  const items = useMemo<PendingRequestDescriptor[]>(() => {
    const all: PendingRequestDescriptor[] = []
    for (const r of pendingSecretRequests) {
      all.push({
        kind: 'secret',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        secretName: r.secretName,
        reason: r.reason,
        onComplete: () => handleSecretRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingConnectedAccountRequests) {
      all.push({
        kind: 'connected_account',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        toolkit: r.toolkit,
        reason: r.reason,
        onComplete: () => handleConnectedAccountRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingRemoteMcpRequests) {
      all.push({
        kind: 'remote_mcp',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        url: r.url,
        name: r.name,
        reason: r.reason,
        authHint: r.authHint,
        onComplete: () => handleRemoteMcpRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingQuestionRequests) {
      all.push({
        kind: 'question',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        questions: r.questions,
        onComplete: () => handleQuestionRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingFileRequests) {
      all.push({
        kind: 'file',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        description: r.description,
        fileTypes: r.fileTypes,
        onComplete: () => handleFileRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingBrowserInputRequests) {
      all.push({
        kind: 'browser_input',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        message: r.message,
        requirements: r.requirements,
        onComplete: () => handleBrowserInputRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingScriptRunRequests) {
      all.push({
        kind: 'script_run',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        script: r.script,
        explanation: r.explanation,
        scriptType: r.scriptType,
        onComplete: () => handleScriptRunRequestComplete(r.toolUseId),
      })
    }
    for (const r of pendingComputerUseRequests) {
      all.push({
        kind: 'computer_use',
        key: r.toolUseId,
        toolUseId: r.toolUseId,
        method: r.method,
        params: r.params,
        permissionLevel: r.permissionLevel,
        appName: r.appName,
        onComplete: () => handleComputerUseRequestComplete(r.toolUseId),
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
        onComplete: () => handleCapabilityReviewRequestComplete(r.toolUseId),
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
    return all.sort((a, b) => getArrivalOrder(a.key) - getArrivalOrder(b.key))
  }, [
    pendingSecretRequests, pendingConnectedAccountRequests, pendingRemoteMcpRequests,
    pendingQuestionRequests, pendingFileRequests, pendingBrowserInputRequests,
    pendingScriptRunRequests, pendingComputerUseRequests, pendingCapabilityReviewRequests, pendingProxyReviews,
    getArrivalOrder,
    handleSecretRequestComplete, handleConnectedAccountRequestComplete,
    handleRemoteMcpRequestComplete, handleQuestionRequestComplete,
    handleFileRequestComplete, handleBrowserInputRequestComplete,
    handleScriptRunRequestComplete, handleComputerUseRequestComplete,
    handleCapabilityReviewRequestComplete, handleProxyReviewComplete,
  ])

  return { items, count: items.length }
}
