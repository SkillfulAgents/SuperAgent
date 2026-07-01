import { useCallback, useEffect, useMemo, useRef } from 'react'
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
} from '@renderer/hooks/use-message-stream'
import { useMessages } from '@renderer/hooks/use-messages'
import { usePendingProxyReviews, type PendingReview } from '@renderer/hooks/use-proxy-reviews'
import { isTurnStartingUserMessage, type PendingMessage } from './pending-message'
import { computerUseMethodFromToolName, getRequiredPermissionLevel, resolveTargetApp } from '@shared/lib/computer-use/types'
import { askUserQuestionDef } from '@shared/lib/tool-definitions/ask-user-question'

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

export type PendingRequestDescriptor =
  | { kind: 'secret'; key: string; toolUseId: string; secretName: string; reason?: string; onComplete: () => void }
  | { kind: 'connected_account'; key: string; toolUseId: string; toolkit: string; reason?: string; onComplete: () => void }
  | { kind: 'remote_mcp'; key: string; toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer'; onComplete: () => void }
  | { kind: 'question'; key: string; toolUseId: string; questions: Question[]; onComplete: () => void }
  | { kind: 'file'; key: string; toolUseId: string; description: string; fileTypes?: string; onComplete: () => void }
  | { kind: 'browser_input'; key: string; toolUseId: string; message: string; requirements: string[]; onComplete: () => void }
  | { kind: 'script_run'; key: string; toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell'; onComplete: () => void }
  | { kind: 'computer_use'; key: string; toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; onComplete: () => void }
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
  const { data: messages } = useMessages(sessionId, agentSlug)
  const {
    isActive,
    pendingSecretRequests: sseSecretRequests,
    pendingConnectedAccountRequests: sseConnectedAccountRequests,
    pendingRemoteMcpRequests: sseRemoteMcpRequests,
    pendingQuestionRequests: sseQuestionRequests,
    pendingFileRequests: sseFileRequests,
    pendingBrowserInputRequests: sseBrowserInputRequests,
    pendingScriptRunRequests: sseScriptRunRequests,
    pendingComputerUseRequests: sseComputerUseRequests,
    streamingToolUses,
    autoApprovedScriptRunIds,
    autoApprovedComputerUseIds,
  } = useMessageStream(sessionId, agentSlug)

  const { data: proxyReviewsData, refetch: refetchProxyReviews } = usePendingProxyReviews(agentSlug)
  const pendingProxyReviews = useMemo(() => proxyReviewsData?.reviews ?? [], [proxyReviewsData])

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

  // Track toolUseIds the user has already answered, so the message-based
  // recovery source doesn't re-surface them before the tool result is persisted.
  const dismissedRequestIds = useRef(new Set<string>())

  // Clear dismissed set when session transitions from active → idle.
  const prevIsActive = useRef(isActive)
  useEffect(() => {
    if (prevIsActive.current && !isActive) {
      dismissedRequestIds.current.clear()
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
    for (const req of [...sseSecretRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseSecretRequests, streamingBasedPendingRequests.secretRequests, messagesBasedPendingRequests.secretRequests, isActive])

  const pendingConnectedAccountRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; toolkit: string; reason?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.connectedAccountRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.connectedAccountRequests : []
    for (const req of [...sseConnectedAccountRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseConnectedAccountRequests, streamingBasedPendingRequests.connectedAccountRequests, messagesBasedPendingRequests.connectedAccountRequests, isActive])

  const pendingQuestionRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; questions: Question[] }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.questionRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.questionRequests : []
    for (const req of [...sseQuestionRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseQuestionRequests, streamingBasedPendingRequests.questionRequests, messagesBasedPendingRequests.questionRequests, isActive])

  const pendingFileRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; description: string; fileTypes?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.fileRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.fileRequests : []
    for (const req of [...sseFileRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseFileRequests, streamingBasedPendingRequests.fileRequests, messagesBasedPendingRequests.fileRequests, isActive])

  const pendingRemoteMcpRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.remoteMcpRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.remoteMcpRequests : []
    for (const req of [...sseRemoteMcpRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseRemoteMcpRequests, streamingBasedPendingRequests.remoteMcpRequests, messagesBasedPendingRequests.remoteMcpRequests, isActive])

  const pendingBrowserInputRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; message: string; requirements: string[] }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.browserInputRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.browserInputRequests : []
    for (const req of [...sseBrowserInputRequests, ...streamingBased, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseBrowserInputRequests, streamingBasedPendingRequests.browserInputRequests, messagesBasedPendingRequests.browserInputRequests, isActive])

  const pendingScriptRunRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.scriptRunRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.scriptRunRequests : []
    for (const req of [...sseScriptRunRequests, ...streamingBased, ...messageBased]) {
      if (autoApprovedScriptRunIds.has(req.toolUseId)) continue
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseScriptRunRequests, streamingBasedPendingRequests.scriptRunRequests, messagesBasedPendingRequests.scriptRunRequests, isActive, autoApprovedScriptRunIds])

  const pendingComputerUseRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.computerUseRequests : []
    const streamingBased = isActive ? streamingBasedPendingRequests.computerUseRequests : []
    for (const req of [...sseComputerUseRequests, ...streamingBased, ...messageBased]) {
      if (autoApprovedComputerUseIds.has(req.toolUseId)) continue
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseComputerUseRequests, streamingBasedPendingRequests.computerUseRequests, messagesBasedPendingRequests.computerUseRequests, isActive, autoApprovedComputerUseIds])

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
    ]) {
      for (const req of arr) ids.push(req.toolUseId)
    }
    for (const review of pendingProxyReviews) ids.push(review.id)
    return ids
  }, [
    pendingSecretRequests, pendingConnectedAccountRequests, pendingRemoteMcpRequests,
    pendingQuestionRequests, pendingFileRequests, pendingBrowserInputRequests,
    pendingScriptRunRequests, pendingComputerUseRequests, pendingProxyReviews,
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
    dismissedRequestIds.current.add(toolUseId)
    removeSecretRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleConnectedAccountRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeConnectedAccountRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleQuestionRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeQuestionRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleRemoteMcpRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeRemoteMcpRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleFileRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeFileRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleScriptRunRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeScriptRunRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleComputerUseRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeComputerUseRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleBrowserInputRequestComplete = useCallback((toolUseId: string) => {
    dismissedRequestIds.current.add(toolUseId)
    removeBrowserInputRequest(sessionId, toolUseId)
  }, [sessionId])

  const handleProxyReviewComplete = useCallback(() => {
    refetchProxyReviews()
  }, [refetchProxyReviews])

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
    pendingScriptRunRequests, pendingComputerUseRequests, pendingProxyReviews,
    getArrivalOrder,
    handleSecretRequestComplete, handleConnectedAccountRequestComplete,
    handleRemoteMcpRequestComplete, handleQuestionRequestComplete,
    handleFileRequestComplete, handleBrowserInputRequestComplete,
    handleScriptRunRequestComplete, handleComputerUseRequestComplete,
    handleProxyReviewComplete,
  ])

  return { items, count: items.length }
}
