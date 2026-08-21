
import { useMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { usePendingUserRequests } from '@renderer/hooks/use-pending-user-requests'
import { apiFetch } from '@renderer/lib/api'
import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'
import { InsufficientBalanceCard, usePlatformBillingUrl } from './insufficient-balance-card'
import { PROVIDER_ERROR_CODES } from '@shared/lib/types/api'
import { isTurnStartingUserMessage } from './pending-message'
import { useCallback, useMemo, useState } from 'react'

import { deriveTaskList, Todo } from '@shared/lib/utils/derive-task-list'
import { ActivityCard, ActivityErrorCard, type ActivitySubagentItem } from './activity-card'
import { deriveActivityStatus } from './activity-orb'

interface AgentActivityIndicatorProps {
  sessionId: string
  agentSlug: string
}

function extractResumedAgentId(result: unknown): string | null {
  if (typeof result === 'string') {
    try {
      return extractResumedAgentId(JSON.parse(result))
    } catch {
      return null
    }
  }

  if (Array.isArray(result)) {
    for (const block of result) {
      const agentId = extractResumedAgentId(block)
      if (agentId) return agentId
    }
    return null
  }

  if (!result || typeof result !== 'object') return null

  const resumedAgentId = (result as { resumedAgentId?: unknown }).resumedAgentId
  if (typeof resumedAgentId === 'string' && resumedAgentId.length > 0) {
    return resumedAgentId
  }

  const text = (result as { text?: unknown }).text
  return typeof text === 'string' ? extractResumedAgentId(text) : null
}

export function AgentActivityIndicator({ sessionId, agentSlug }: AgentActivityIndicatorProps) {
  const {
    isActive, error, apiErrorCode, activeStartTime, isCompacting, activeSubagents, completedSubagents,
    apiRetry, computerUseApp, computerUseAppIcon, backgroundTasks,
    isThinking,
  } = useMessageStream(sessionId, agentSlug)
  const { data: pendingUserRequests } = usePendingUserRequests(agentSlug, sessionId)

  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState(false)

  // Non-null only for a platform billing 402 the workspace can act on (see hook).
  const billingUrl = usePlatformBillingUrl(error ?? '')

  const handleRevokeComputerUse = useCallback(async () => {
    setRevoking(true)
    setRevokeError(false)
    try {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/computer-use/revoke`, { method: 'POST' })
      if (!res.ok) throw new Error()
    } catch {
      setRevokeError(true)
    } finally {
      setRevoking(false)
    }
  }, [agentSlug, sessionId])

  // The unified store's blocking predicate is the SAME one the server derives
  // the session's awaiting status from, so this indicator can no longer
  // disagree with the sidebar/header. It also covers the kinds the old
  // per-type list silently omitted: script_run, computer_use, and
  // capability_review used to read as "Working…" while a card was parked.
  const isAwaitingInput = isActive &&
    (pendingUserRequests ?? []).some((r) => r.blocking && !r.autoApproved)
  const { data: messages } = useMessages(sessionId, agentSlug)

  // Use activeStartTime from SSE (set when session_active fires) as primary source.
  // Falls back to last persisted user message timestamp (for page refresh recovery).
  // Queued (mid-turn) messages don't start a turn — skipping them keeps the
  // elapsed timer anchored to the turn-starting prompt after a refresh.
  const timerStartTime = useMemo(() => {
    if (activeStartTime) return new Date(activeStartTime)
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartingUserMessage(messages[i])) {
        return new Date(messages[i].createdAt)
      }
    }
    return null
  }, [activeStartTime, messages])

  const elapsed = useElapsedTimer(isActive ? timerStartTime : null)

  // Build one display row per stable agentId. A SendMessage resume gets a new
  // tool_use id but keeps the agentId, so keying rows by the launch tool alone
  // leaves the original row completed while the resumed run works invisibly.
  const subagentItems = useMemo<ActivitySubagentItem[]>(() => {
    if (!messages || activeSubagents.length === 0) return []

    type LaunchMetadata = {
      agentId: string | null
      name: string
      description: string
      completedFromResult: boolean
    }
    type ResumeMetadata = {
      agentId: string | null
    }
    const launchByToolId = new Map<string, LaunchMetadata>()
    const launchByAgentId = new Map<string, LaunchMetadata>()
    const launches: LaunchMetadata[] = []
    const resumeByToolId = new Map<string, ResumeMetadata>()

    for (const msg of messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue
      for (const tc of msg.toolCalls || []) {
        if (tc.name === 'Agent' || tc.name === 'Task') {
          if (tc.isError) continue
          const input = tc.input as { subagent_type?: string; description?: string }
          const isAsyncLaunched = tc.subagent?.status === 'async_launched'
          const metadata = {
            agentId: tc.subagent?.agentId ?? null,
            name: input.subagent_type || tc.name,
            description: input.description || '',
            completedFromResult: !isAsyncLaunched && tc.result != null,
          }
          launchByToolId.set(tc.id, metadata)
          launches.push(metadata)
          if (tc.subagent?.agentId) {
            launchByAgentId.set(tc.subagent.agentId, metadata)
          }
        } else if (tc.name === 'SendMessage') {
          const input = tc.input as { to?: string; recipient?: string }
          const target = input.to ?? input.recipient ?? null
          const resultAgentId = extractResumedAgentId(tc.result)
          resumeByToolId.set(tc.id, {
            agentId: resultAgentId ?? (target && launchByAgentId.has(target) ? target : null),
          })
        }
      }
    }

    const findMatchingLaunchAgentId = (sub: (typeof activeSubagents)[number]) => {
      const hasName = !!sub.subagentType
      const hasDescription = !!sub.description
      if (!hasName && !hasDescription) return null

      // Before the SendMessage result persists, its name target is not a stable
      // agent ID. Join only when the lifecycle metadata identifies exactly one
      // prior launch; ambiguous matches remain separate until the ID arrives.
      const matches = new Set(
        launches
          .filter((launch) =>
            launch.agentId &&
            (!hasName || launch.name === sub.subagentType) &&
            (!hasDescription || launch.description === sub.description)
          )
          .map((launch) => launch.agentId!)
      )
      return matches.size === 1 ? [...matches][0] : null
    }

    const groups = new Map<string, typeof activeSubagents>()
    for (const sub of activeSubagents) {
      const directLaunch = sub.parentToolId
        ? launchByToolId.get(sub.parentToolId)
        : undefined
      const originalLaunch = sub.agentId
        ? launchByAgentId.get(sub.agentId)
        : undefined
      const resume = sub.parentToolId
        ? resumeByToolId.get(sub.parentToolId)
        : undefined
      const isSendMessageRun = resume !== undefined
      // local_workflow also emits subagent lifecycle events, but it has its own
      // activity UI. Only Agent/Task launches and their SendMessage resumes
      // belong in this list.
      if (!directLaunch && !originalLaunch && !isSendMessageRun) continue

      const stableAgentId = sub.agentId
        ?? directLaunch?.agentId
        ?? resume?.agentId
        ?? (isSendMessageRun ? findMatchingLaunchAgentId(sub) : null)
      if (!stableAgentId && !sub.parentToolId) continue
      const key = stableAgentId
        ? `agent:${stableAgentId}`
        : `tool:${sub.parentToolId}`
      const group = groups.get(key) ?? []
      group.push(sub)
      groups.set(key, group)
    }

    const isCompleted = (sub: (typeof activeSubagents)[number]) => {
      const parentToolId = sub.parentToolId
      if (parentToolId && completedSubagents?.has(parentToolId)) return true
      return !!parentToolId && (launchByToolId.get(parentToolId)?.completedFromResult ?? false)
    }

    return [...groups.entries()].map(([key, group]) => {
      let selected = group[group.length - 1]
      for (let i = group.length - 1; i >= 0; i--) {
        if (!isCompleted(group[i])) {
          selected = group[i]
          break
        }
      }

      const directLaunch = selected.parentToolId
        ? launchByToolId.get(selected.parentToolId)
        : undefined
      const selectedAgentId = selected.agentId
        ?? directLaunch?.agentId
        ?? (selected.parentToolId ? resumeByToolId.get(selected.parentToolId)?.agentId : undefined)
        ?? (selected.parentToolId && resumeByToolId.has(selected.parentToolId)
          ? findMatchingLaunchAgentId(selected)
          : null)
      const originalLaunch = selectedAgentId
        ? launchByAgentId.get(selectedAgentId)
        : undefined
      const metadata = directLaunch ?? originalLaunch

      return {
        id: selectedAgentId ?? selected.parentToolId ?? key,
        name: selected.subagentType || metadata?.name || 'Agent',
        description: selected.description || metadata?.description || '',
        status: isCompleted(selected) ? 'completed' as const : 'running' as const,
        progressSummary: selected.progressSummary ?? null,
      }
    })
  }, [messages, activeSubagents, completedSubagents])

  // Derive the todo/task list from TaskCreate/TaskUpdate (newer SDK) or fall back
  // to TodoWrite (older SDK). Memoized on [messages] so it doesn't re-scan the
  // whole transcript on every per-delta re-render driven by useMessageStream —
  // only when the persisted message list actually changes.
  const { todos, activeItem } = useMemo<{ todos: Todo[] | null; activeItem: Todo | null }>(
    () => deriveTaskList(messages),
    [messages]
  )


  // Show error if present
  if (error) {
    const isProviderError = apiErrorCode != null && PROVIDER_ERROR_CODES.has(apiErrorCode)
    return (
      <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
        {billingUrl ? (
          <InsufficientBalanceCard billingUrl={billingUrl} data-testid="insufficient-balance-card" />
        ) : isProviderError ? (
          <ProviderErrorCard message={error} data-testid="provider-error-card" />
        ) : (
          <ActivityErrorCard message={error} />
        )}
      </div>
    )
  }

  // Don't render if not active
  if (!isActive) {
    return null
  }

  // One precedence order drives both the label and the orb's animation.
  const { statusText, orbState } = deriveActivityStatus({
    isAwaitingInput,
    isCompacting,
    apiRetry,
    isThinking,
    activeForm: activeItem?.activeForm ?? null,
  })

  return (
    <ActivityCard
      statusText={statusText}
      orbState={orbState}
      elapsed={elapsed}
      isAwaitingInput={isAwaitingInput}
      computerUse={computerUseApp ? {
        app: computerUseApp,
        iconBase64: computerUseAppIcon,
        revoking,
        revokeError,
        onRevoke: handleRevokeComputerUse,
      } : null}
      subagents={subagentItems}
      backgroundTasks={backgroundTasks}
      todos={todos}
    />
  )
}
