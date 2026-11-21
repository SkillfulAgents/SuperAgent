import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { createSessionMemory, nextFocus, type TrayFocus } from '@renderer/lib/session-memory'
import type { ApiToolCall } from '@shared/lib/types/api'

export interface OpenWorkflow {
  runId: string
  name?: string
  /** The one agent of the run whose transcript the tab is showing; absent on the run's own list. */
  agentId?: string
}

/** The drawer's one Subagents tab: a list of the session's subagents that drills into each. */
export interface SubagentsTab {
  open: boolean
  /**
   * The subagent whose transcript is showing, as its Agent tool call was when
   * it was picked; null on the list. The call's saved copy is found in the
   * transcript, and this copy covers the time before it has one.
   */
  viewing: ApiToolCall | null
}

/** Every subagent shares this one tab, however many there are. */
export const SUBAGENTS_TAB_KEY = 'agent:subagents'

/** The drawer's one Background tasks tab: the session's background commands and monitors, drilling into each. */
export interface BackgroundTab {
  open: boolean
  /** The task whose detail is showing, by its runtime task id; null on the list. */
  viewing: string | null
}

export const BACKGROUND_TAB_KEY = 'agent:background'

/** A session another agent ran at this session's call (invoke_agent). */
export interface AgentCallTab {
  /** The called agent. */
  slug: string
  /** The session the call ran in. */
  sessionId: string
}

/** The drawer's one Invoked agents tab: the sessions this one called, drilling into each conversation. */
export interface AgentSessionsTab {
  open: boolean
  /** The called session whose conversation is showing; null on the list. */
  viewing: AgentCallTab | null
}

/** Every called session shares this one tab, as every subagent shares theirs. */
export const AGENT_SESSIONS_TAB_KEY = 'agent:sessions'

export function workflowTabKey(runId: string): string {
  return `workflow:${runId}`
}

interface WorkflowContextType {
  /** Workflow runs with a tab in the drawer. */
  openWorkflows: OpenWorkflow[]
  subagents: SubagentsTab
  /** The tab the last open call asked for, for the drawer to bring to the front. */
  focus: TrayFocus | null

  openWorkflow: (runId: string, name?: string) => void
  closeWorkflow: (runId: string) => void
  /** Show one agent of a run inside the run's tab, or go back to the run with null. */
  viewWorkflowAgent: (runId: string, agentId: string | null) => void
  /** Open the Subagents tab on one subagent's transcript. */
  openSubagent: (toolCall: ApiToolCall) => void
  /** Open the Subagents tab where it was left: on its list, unless a subagent was being read. */
  openSubagents: () => void
  /** Show one subagent inside the Subagents tab, or go back to the list with null. */
  viewSubagent: (toolCall: ApiToolCall | null) => void
  closeSubagents: () => void

  background: BackgroundTab
  /** Open the Background tasks tab on one task. */
  openBackgroundTask: (taskId: string) => void
  /** Open the Background tasks tab where it was left. */
  openBackgroundTasks: () => void
  /** Show one task inside the tab, or go back to the list with null. */
  viewBackgroundTask: (taskId: string | null) => void
  closeBackgroundTasks: () => void

  agentSessions: AgentSessionsTab
  /** Open the Invoked agents tab on one called session's conversation. */
  openAgentCall: (call: AgentCallTab) => void
  /** Open the Invoked agents tab where it was left. */
  openAgentSessions: () => void
  /** Show one called session inside the tab, or go back to the list with null. */
  viewAgentCall: (call: AgentCallTab | null) => void
  closeAgentSessions: () => void
}

const WorkflowContext = createContext<WorkflowContextType | null>(null)

const NO_SUBAGENTS: SubagentsTab = { open: false, viewing: null }
const NO_BACKGROUND: BackgroundTab = { open: false, viewing: null }
const NO_AGENT_SESSIONS: AgentSessionsTab = { open: false, viewing: null }

interface WorkflowSnapshot {
  openWorkflows: OpenWorkflow[]
  subagents: SubagentsTab
  background: BackgroundTab
  agentSessions: AgentSessionsTab
}
const workflowMemory = createSessionMemory<WorkflowSnapshot>()

/**
 * Holds what the side drawer has open for workflow runs and for subagents.
 * Mirrors FilePreviewProvider: state belongs to one session, and opening
 * something that is already open asks for its tab again. A run is a tab, and
 * every subagent shares one tab; inside either, one agent can be picked to read
 * its transcript. What a run or an agent did is fetched from the host, and
 * which tab is in front is the drawer's to know.
 */
export function WorkflowProvider({
  children,
  sessionId: sessionIdProp,
  rememberTabs = false,
}: {
  children: ReactNode
  sessionId?: string | null
  /** Keep this session's tabs for when it is opened again. For real sessions, not a home page's preview. */
  rememberTabs?: boolean
}) {
  const { view } = useRouteLocation()
  // Views that own a session can pass it explicitly so state changes with the
  // session; otherwise derive from the active route (same as FilePreviewProvider).
  const sessionId = sessionIdProp !== undefined ? sessionIdProp : view.kind === 'session' ? view.id : null

  const [openWorkflows, setOpenWorkflows] = useState<OpenWorkflow[]>([])
  const [subagents, setSubagents] = useState<SubagentsTab>(NO_SUBAGENTS)
  const [background, setBackground] = useState<BackgroundTab>(NO_BACKGROUND)
  const [agentSessions, setAgentSessions] = useState<AgentSessionsTab>(NO_AGENT_SESSIONS)
  const [focus, setFocus] = useState<TrayFocus | null>(null)

  // Each session has its own tabs. Leaving one stores them and coming back
  // restores them; a session seen for the first time starts empty.
  const latest = useRef<WorkflowSnapshot>({ openWorkflows, subagents, background, agentSessions })
  useEffect(() => {
    latest.current = { openWorkflows, subagents, background, agentSessions }
  })
  useEffect(() => {
    const kept = rememberTabs && sessionId ? workflowMemory.get(sessionId) : undefined
    setOpenWorkflows(kept?.openWorkflows ?? [])
    setSubagents(kept?.subagents ?? NO_SUBAGENTS)
    setBackground(kept?.background ?? NO_BACKGROUND)
    setAgentSessions(kept?.agentSessions ?? NO_AGENT_SESSIONS)
    setFocus(null)
    return () => {
      if (rememberTabs && sessionId) workflowMemory.set(sessionId, latest.current)
    }
  }, [sessionId, rememberTabs])

  const openWorkflow = useCallback((runId: string, name?: string) => {
    setOpenWorkflows((prev) => {
      const idx = prev.findIndex((w) => w.runId === runId)
      if (idx >= 0) {
        // Opening the run shows the run itself, and backfills a name we didn't have.
        const current = prev[idx]
        const nextName = current.name ?? name
        if (current.agentId === undefined && nextName === current.name) return prev
        const next = [...prev]
        next[idx] = { runId, name: nextName }
        return next
      }
      return [...prev, { runId, name }]
    })
    setFocus((previous) => nextFocus(previous, workflowTabKey(runId)))
  }, [])

  const closeWorkflow = useCallback((runId: string) => {
    setOpenWorkflows((prev) => prev.filter((w) => w.runId !== runId))
  }, [])

  const viewWorkflowAgent = useCallback((runId: string, agentId: string | null) => {
    setOpenWorkflows((prev) => prev.map((w) => (
      w.runId === runId ? { runId, name: w.name, ...(agentId ? { agentId } : {}) } : w
    )))
  }, [])

  const openSubagent = useCallback((toolCall: ApiToolCall) => {
    setSubagents({ open: true, viewing: toolCall })
    setFocus((previous) => nextFocus(previous, SUBAGENTS_TAB_KEY))
  }, [])

  const openSubagents = useCallback(() => {
    setSubagents((current) => ({ open: true, viewing: current.viewing }))
    setFocus((previous) => nextFocus(previous, SUBAGENTS_TAB_KEY))
  }, [])

  const viewSubagent = useCallback((toolCall: ApiToolCall | null) => {
    setSubagents({ open: true, viewing: toolCall })
  }, [])

  const closeSubagents = useCallback(() => {
    setSubagents(NO_SUBAGENTS)
  }, [])

  const openBackgroundTask = useCallback((taskId: string) => {
    setBackground({ open: true, viewing: taskId })
    setFocus((previous) => nextFocus(previous, BACKGROUND_TAB_KEY))
  }, [])

  const openBackgroundTasks = useCallback(() => {
    setBackground((current) => ({ open: true, viewing: current.viewing }))
    setFocus((previous) => nextFocus(previous, BACKGROUND_TAB_KEY))
  }, [])

  const viewBackgroundTask = useCallback((taskId: string | null) => {
    setBackground({ open: true, viewing: taskId })
  }, [])

  const closeBackgroundTasks = useCallback(() => {
    setBackground(NO_BACKGROUND)
  }, [])

  const openAgentCall = useCallback((call: AgentCallTab) => {
    setAgentSessions({ open: true, viewing: { slug: call.slug, sessionId: call.sessionId } })
    setFocus((previous) => nextFocus(previous, AGENT_SESSIONS_TAB_KEY))
  }, [])

  const openAgentSessions = useCallback(() => {
    setAgentSessions((current) => ({ open: true, viewing: current.viewing }))
    setFocus((previous) => nextFocus(previous, AGENT_SESSIONS_TAB_KEY))
  }, [])

  const viewAgentCall = useCallback((call: AgentCallTab | null) => {
    setAgentSessions({ open: true, viewing: call })
  }, [])

  const closeAgentSessions = useCallback(() => {
    setAgentSessions(NO_AGENT_SESSIONS)
  }, [])

  const value = useMemo<WorkflowContextType>(
    () => ({
      openWorkflows,
      subagents,
      focus,
      openWorkflow,
      closeWorkflow,
      viewWorkflowAgent,
      openSubagent,
      openSubagents,
      viewSubagent,
      closeSubagents,
      background,
      openBackgroundTask,
      openBackgroundTasks,
      viewBackgroundTask,
      closeBackgroundTasks,
      agentSessions,
      openAgentCall,
      openAgentSessions,
      viewAgentCall,
      closeAgentSessions,
    }),
    [openWorkflows, subagents, focus, openWorkflow, closeWorkflow, viewWorkflowAgent, openSubagent, openSubagents, viewSubagent, closeSubagents,
      background, openBackgroundTask, openBackgroundTasks, viewBackgroundTask, closeBackgroundTasks, agentSessions, openAgentCall, openAgentSessions, viewAgentCall, closeAgentSessions]
  )

  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}

/** The drawer's tabs where a WorkflowProvider is above, else null: for parts drawn outside a session too. */
export function useOptionalWorkflow(): WorkflowContextType | null {
  return useContext(WorkflowContext)
}

export function useWorkflow(): WorkflowContextType {
  const ctx = useContext(WorkflowContext)
  if (!ctx) throw new Error('useWorkflow must be used within WorkflowProvider')
  return ctx
}
