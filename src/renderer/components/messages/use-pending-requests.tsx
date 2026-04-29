import { useCallback, useMemo, useRef, type ReactElement } from 'react'
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
import { usePendingProxyReviews } from '@renderer/hooks/use-proxy-reviews'
import { SecretRequestItem } from './secret-request-item'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'
import { QuestionRequestItem } from './question-request-item'
import { FileRequestItem } from './file-request-item'
import { BrowserInputRequestItem } from './browser-input-request-item'
import { ScriptRunRequestItem } from './script-run-request-item'
import { ComputerUseRequestItem } from './computer-use-request-item'
import { ProxyReviewRequestItem } from './proxy-review-request-item'
import { XAgentReviewRequestItem } from './x-agent-review-request-item'

interface PendingMessage {
  text: string
  sentAt: number
  sender?: { id: string; name: string; email: string }
}

interface UsePendingRequestsArgs {
  sessionId: string
  agentSlug: string
  pendingUserMessage?: PendingMessage | null
  isViewOnly: boolean
}

interface UsePendingRequestsResult {
  items: ReactElement[]
  count: number
}

export function usePendingRequests({
  sessionId,
  agentSlug,
  pendingUserMessage,
  isViewOnly,
}: UsePendingRequestsArgs): UsePendingRequestsResult {
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
    const questionRequests: {
      toolUseId: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }[] = []
    const fileRequests: { toolUseId: string; description: string; fileTypes?: string }[] = []
    const remoteMcpRequests: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []
    const browserInputRequests: { toolUseId: string; message: string; requirements: string[] }[] = []
    const scriptRunRequests: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []

    if (!messages) return { secretRequests, connectedAccountRequests, questionRequests, fileRequests, remoteMcpRequests, browserInputRequests, scriptRunRequests }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.type !== 'assistant') continue

      const hasSubsequentUserMessage = !!pendingUserMessage || messages.slice(i + 1).some((m) => m.type === 'user')
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
          const input = toolCall.input as {
            questions?: Array<{
              question: string
              header: string
              options: Array<{ label: string; description: string }>
              multiSelect: boolean
            }>
          }
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
  }, [messages, pendingUserMessage])

  // Track toolUseIds the user has already answered, so the message-based
  // recovery source doesn't re-surface them before the tool result is persisted.
  const dismissedRequestIds = useRef(new Set<string>())

  // Clear dismissed set when session becomes idle
  const prevIsActive = useRef(isActive)
  if (prevIsActive.current && !isActive) {
    dismissedRequestIds.current.clear()
  }
  prevIsActive.current = isActive

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
    const merged: {
      toolUseId: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }[] = []
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

  // Track arrival order so the stack is chronological. Each toolUseId gets a
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

  useMemo(() => {
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

  const getArrivalOrder = useCallback((toolUseId: string) => {
    return arrivalOrder.current.get(toolUseId) ?? Infinity
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

  const items = useMemo<ReactElement[]>(() => {
    return [
      ...pendingSecretRequests.map((request) => (
        <SecretRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          secretName={request.secretName}
          reason={request.reason}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleSecretRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingConnectedAccountRequests.map((request) => (
        <ConnectedAccountRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          toolkit={request.toolkit}
          reason={request.reason}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleConnectedAccountRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingRemoteMcpRequests.map((request) => (
        <RemoteMcpRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          url={request.url}
          name={request.name}
          reason={request.reason}
          authHint={request.authHint}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleRemoteMcpRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingQuestionRequests.map((request) => (
        <QuestionRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          questions={request.questions}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleQuestionRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingFileRequests.map((request) => (
        <FileRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          description={request.description}
          fileTypes={request.fileTypes}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleFileRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingBrowserInputRequests.map((request) => (
        <BrowserInputRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          message={request.message}
          requirements={request.requirements}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleBrowserInputRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingScriptRunRequests.map((request) => (
        <ScriptRunRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          script={request.script}
          explanation={request.explanation}
          scriptType={request.scriptType}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleScriptRunRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingComputerUseRequests.map((request) => (
        <ComputerUseRequestItem
          key={request.toolUseId}
          toolUseId={request.toolUseId}
          method={request.method}
          params={request.params}
          permissionLevel={request.permissionLevel}
          appName={request.appName}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={isViewOnly}
          onComplete={() => handleComputerUseRequestComplete(request.toolUseId)}
        />
      )),
      ...pendingProxyReviews.map((review) =>
        review.xAgent ? (
          <XAgentReviewRequestItem
            key={review.id}
            reviewId={review.id}
            agentSlug={agentSlug}
            xAgent={review.xAgent}
            readOnly={isViewOnly}
            onComplete={() => refetchProxyReviews()}
          />
        ) : (
          <ProxyReviewRequestItem
            key={review.id}
            reviewId={review.id}
            accountId={review.accountId}
            toolkit={review.toolkit}
            method={review.method}
            targetPath={review.targetPath}
            matchedScopes={review.matchedScopes}
            scopeDescriptions={review.scopeDescriptions}
            displayText={review.displayText}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => refetchProxyReviews()}
          />
        ),
      ),
    ].sort((a, b) => getArrivalOrder(a.key as string) - getArrivalOrder(b.key as string))
  }, [
    pendingSecretRequests, pendingConnectedAccountRequests, pendingRemoteMcpRequests,
    pendingQuestionRequests, pendingFileRequests, pendingBrowserInputRequests,
    pendingScriptRunRequests, pendingComputerUseRequests, pendingProxyReviews,
    sessionId, agentSlug, isViewOnly, refetchProxyReviews, getArrivalOrder,
    handleSecretRequestComplete, handleConnectedAccountRequestComplete,
    handleRemoteMcpRequestComplete, handleQuestionRequestComplete,
    handleFileRequestComplete, handleBrowserInputRequestComplete,
    handleScriptRunRequestComplete, handleComputerUseRequestComplete,
  ])

  return { items, count: items.length }
}
