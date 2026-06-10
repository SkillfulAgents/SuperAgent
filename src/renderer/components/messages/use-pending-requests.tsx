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
import type { PendingMessage } from './pending-message'

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
  // (mid-turn) messages leave the agent blocked on the request.
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
    autoApprovedScriptRunIds,
  } = useMessageStream(sessionId, agentSlug)

  const { data: proxyReviewsData, refetch: refetchProxyReviews } = usePendingProxyReviews(agentSlug)
  const pendingProxyReviews = useMemo(() => proxyReviewsData?.reviews ?? [], [proxyReviewsData])

  // Derive pending requests from message history (for page refresh recovery).
  // Tool calls without a result are still pending, but only if there are no
  // subsequent user messages (which would indicate user has moved past the request).
  const messagesBasedPendingRequests = useMemo(() => {
    const secretRequests: { toolUseId: string; secretName: string; reason?: string }[] = []
    const connectedAccountRequests: { toolUseId: string; toolkit: string; reason?: string }[] = []
    const questionRequests: { toolUseId: string; questions: Question[] }[] = []
    const fileRequests: { toolUseId: string; description: string; fileTypes?: string }[] = []
    const remoteMcpRequests: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []
    const browserInputRequests: { toolUseId: string; message: string; requirements: string[] }[] = []
    const scriptRunRequests: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []

    if (!messages) return { secretRequests, connectedAccountRequests, questionRequests, fileRequests, remoteMcpRequests, browserInputRequests, scriptRunRequests }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.type !== 'assistant') continue

      // Queued (mid-turn) messages don't count — the agent hasn't moved past
      // the request; it stays blocked until the request is answered.
      const hasSubsequentUserMessage =
        hasPendingUserMessage ||
        messages.slice(i + 1).some((m) => m.type === 'user' && !(m as { queued?: boolean }).queued)
      if (hasSubsequentUserMessage) continue

      for (const toolCall of message.toolCalls) {
        if (toolCall.result !== undefined) continue

        if (toolCall.name === 'mcp__user-input__request_secret') {
          const input = toolCall.input as { secretName?: string; reason?: string }
          if (input.secretName) {
            secretRequests.push({
              toolUseId: toolCall.id,
              secretName: input.secretName,
              reason: input.reason,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_connected_account') {
          const input = toolCall.input as { toolkit?: string; reason?: string }
          if (input.toolkit) {
            connectedAccountRequests.push({
              toolUseId: toolCall.id,
              toolkit: input.toolkit,
              reason: input.reason,
            })
          }
        } else if (toolCall.name === 'AskUserQuestion') {
          const input = toolCall.input as { questions?: Question[] }
          if (input.questions?.length) {
            questionRequests.push({
              toolUseId: toolCall.id,
              questions: input.questions,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_remote_mcp') {
          const input = toolCall.input as { url?: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }
          if (input.url) {
            remoteMcpRequests.push({
              toolUseId: toolCall.id,
              url: input.url,
              name: input.name,
              reason: input.reason,
              authHint: input.authHint,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_file') {
          const input = toolCall.input as { description?: string; fileTypes?: string }
          if (input.description) {
            fileRequests.push({
              toolUseId: toolCall.id,
              description: input.description,
              fileTypes: input.fileTypes,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_browser_input') {
          const input = toolCall.input as { message?: string; requirements?: string[] }
          if (input.message) {
            browserInputRequests.push({
              toolUseId: toolCall.id,
              message: input.message,
              requirements: input.requirements || [],
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_script_run') {
          const input = toolCall.input as { script?: string; explanation?: string; scriptType?: 'applescript' | 'shell' | 'powershell' }
          if (input.script && input.scriptType) {
            scriptRunRequests.push({
              toolUseId: toolCall.id,
              script: input.script,
              explanation: input.explanation || '',
              scriptType: input.scriptType,
            })
          }
        }
      }
    }

    return { secretRequests, connectedAccountRequests, questionRequests, fileRequests, remoteMcpRequests, browserInputRequests, scriptRunRequests }
  }, [messages, hasPendingUserMessage])

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
    for (const req of [...sseSecretRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseSecretRequests, messagesBasedPendingRequests.secretRequests, isActive])

  const pendingConnectedAccountRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; toolkit: string; reason?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.connectedAccountRequests : []
    for (const req of [...sseConnectedAccountRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseConnectedAccountRequests, messagesBasedPendingRequests.connectedAccountRequests, isActive])

  const pendingQuestionRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; questions: Question[] }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.questionRequests : []
    for (const req of [...sseQuestionRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseQuestionRequests, messagesBasedPendingRequests.questionRequests, isActive])

  const pendingFileRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; description: string; fileTypes?: string }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.fileRequests : []
    for (const req of [...sseFileRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseFileRequests, messagesBasedPendingRequests.fileRequests, isActive])

  const pendingRemoteMcpRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.remoteMcpRequests : []
    for (const req of [...sseRemoteMcpRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseRemoteMcpRequests, messagesBasedPendingRequests.remoteMcpRequests, isActive])

  const pendingBrowserInputRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; message: string; requirements: string[] }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.browserInputRequests : []
    for (const req of [...sseBrowserInputRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseBrowserInputRequests, messagesBasedPendingRequests.browserInputRequests, isActive])

  const pendingScriptRunRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []
    const messageBased = isActive ? messagesBasedPendingRequests.scriptRunRequests : []
    for (const req of [...sseScriptRunRequests, ...messageBased]) {
      if (autoApprovedScriptRunIds.has(req.toolUseId)) continue
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseScriptRunRequests, messagesBasedPendingRequests.scriptRunRequests, isActive, autoApprovedScriptRunIds])

  const pendingComputerUseRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }[] = []
    for (const req of sseComputerUseRequests) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseComputerUseRequests])

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
