
import { useIsVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { useMessages, useStopBackgroundTask } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePendingUserRequests } from '@shared/lib/tools/requests/use-pending-user-requests'
import { apiFetch } from '@renderer/lib/api'
import { labelBackgroundTasks } from '@renderer/lib/background-task-label'
import { resolveProviderError } from '@renderer/components/provider-error/provider-error-registry'
import { isProviderFacingError } from '@shared/lib/types/api'
import { isTurnStartingUserMessage } from './pending-message'
import { useCallback, useMemo, useState } from 'react'

import { deriveTaskList, Todo } from '@shared/lib/utils/derive-task-list'
import { ActivityCard, ActivityErrorCard, type ActivitySubagentItem } from './activity-card'
import { deriveActivityStatus, deriveIdleStatus } from './activity-orb'

interface AgentActivityIndicatorProps {
  sessionId: string
  agentSlug: string
}

export function AgentActivityIndicator({ sessionId, agentSlug }: AgentActivityIndicatorProps) {
  const {
    isActive, error, apiErrorCode, errorPresentation, activeStartTime, isCompacting, activeSubagents, completedSubagents,
    apiRetry, computerUseApp, computerUseAppIcon, backgroundTasks,
    isThinking,
  } = useMessageStream(sessionId, agentSlug)
  const { data: pendingUserRequests } = usePendingUserRequests(agentSlug, sessionId)
  const { data: agent } = useAgent(agentSlug)

  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState(false)

  const stopBackgroundTask = useStopBackgroundTask()
  const handleStopTask = useCallback(
    async (taskId: string) => {
      await stopBackgroundTask.mutateAsync({ sessionId, agentSlug, taskId })
    },
    [stopBackgroundTask, sessionId, agentSlug]
  )

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
  const voiceModeActive = useIsVoiceModeActive(sessionId)
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
  const turnCount = useMemo(
    () => messages?.filter(isTurnStartingUserMessage).length ?? 0,
    [messages]
  )

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
    const launchByToolId = new Map<string, LaunchMetadata>()
    const launchByAgentId = new Map<string, LaunchMetadata>()

    for (const msg of messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue
      for (const tc of msg.toolCalls || []) {
        if (tc.name !== 'Agent' && tc.name !== 'Task') continue
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
        if (tc.subagent?.agentId) {
          launchByAgentId.set(tc.subagent.agentId, metadata)
        }
      }
    }

    // Every live run names its agent: the host stamps the agentId (the
    // task_started task_id, or the frame's agent_id) on the first event of a
    // run, including a SendMessage run, whose own call is not an Agent launch.
    const groups = new Map<string, typeof activeSubagents>()
    for (const sub of activeSubagents) {
      const directLaunch = sub.parentToolId
        ? launchByToolId.get(sub.parentToolId)
        : undefined
      const originalLaunch = sub.agentId
        ? launchByAgentId.get(sub.agentId)
        : undefined
      const isLifecycleAgent = !!sub.subagentType
      // local_workflow also emits subagent lifecycle events, but it has its own
      // activity UI. A lifecycle-identified Agent may originate in a Skill
      // sidechain and therefore have no launch call in the main transcript.
      if (!directLaunch && !originalLaunch && !isLifecycleAgent) continue

      const stableAgentId = sub.agentId ?? directLaunch?.agentId ?? null
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
      const selectedAgentId = selected.agentId ?? directLaunch?.agentId ?? null
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
        // The agent id is the task id the runtime's stop_task takes.
        taskId: selectedAgentId ?? null,
      }
    })
  }, [messages, activeSubagents, completedSubagents])

  // A subagent reports completion when its own turn ends, but the runtime
  // keeps listing it while background work it started still runs. Its row
  // stays live (with its stop control) until the runtime drops it.
  const subagentRows = useMemo<ActivitySubagentItem[]>(() => {
    const liveAgentTaskIds = new Set(backgroundTasks.filter((task) => task.isSubagent).map((task) => task.taskId))
    return subagentItems.map((item) =>
      item.status === 'completed' && item.taskId && liveAgentTaskIds.has(item.taskId)
        ? { ...item, status: 'running' as const, progressSummary: 'background work still running' }
        : item
    )
  }, [subagentItems, backgroundTasks])

  // Name each background task after the tool call that launched it (the
  // command, the subagent's description) so the rows say what would be stopped.
  const labeledBackgroundTasks = useMemo(
    () => labelBackgroundTasks(backgroundTasks, messages),
    [backgroundTasks, messages]
  )

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
    const isProviderError = isProviderFacingError(apiErrorCode, errorPresentation)
    const providerError = resolveProviderError(errorPresentation)
    // Routed to another placement (e.g. composer): ProviderErrorPlacement renders it there.
    if (isProviderError && providerError.placement !== 'inline') return null
    return (
      <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
        {isProviderError ? (
          <providerError.Component message={error} presentation={errorPresentation ?? undefined} />
        ) : (
          <ActivityErrorCard message={error} />
        )}
      </div>
    )
  }

  // Between turns the drawer stays up as the agent's seat: its avatar at
  // rest over a line read off the session (deriveIdleStatus). Agents without an avatar keep the old behaviour and
  // voice mode has its own surface, so both hide it.
  if (!isActive) {
    if (!agent?.avatar || voiceModeActive) return null
    const statusText = deriveIdleStatus({
      sessionId,
      turnCount,
      pendingTaskCount: todos?.filter((todo) => todo.status !== 'completed').length ?? 0,
    })
    return <ActivityCard statusText={statusText} orbState="working" agent={agent} idle />
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
      agent={agent}
      elapsed={elapsed}
      isAwaitingInput={isAwaitingInput}
      detached={voiceModeActive}
      computerUse={computerUseApp ? {
        app: computerUseApp,
        iconBase64: computerUseAppIcon,
        revoking,
        revokeError,
        onRevoke: handleRevokeComputerUse,
      } : null}
      subagents={subagentRows}
      backgroundTasks={labeledBackgroundTasks}
      todos={todos}
      onStopTask={handleStopTask}
    />
  )
}
