
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

/**
 * Discriminated union describing what is currently shown for the selected agent.
 *
 * The agent slug is orthogonal to the view (you can switch agents without
 * changing the conceptual view). Mutual exclusion between view kinds is
 * enforced by construction — there is exactly one view at a time.
 */
export type AgentView =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'webhook'; id: string }
  | { kind: 'chat'; integrationId: string; sessionId?: string }
  | { kind: 'dashboard'; slug: string }
  | { kind: 'apiLogs' }
  | { kind: 'connections' }
  | { kind: 'secrets' }

const HOME: AgentView = { kind: 'home' }

interface SelectionContextType {
  selectedAgentSlug: string | null
  view: AgentView
  /** One-shot draft text to pre-fill the agent home composer. Consumed on read. */
  pendingDraft: string | null

  /**
   * Select an agent (or clear selection with `null`). Resets the view to home
   * unless `view` is provided — pass a view to atomically dive into a session,
   * task, dashboard, etc. on the new agent without intermediate renders.
   */
  setAgent: (agentSlug: string | null, view?: AgentView) => void
  /** Select an agent and pre-fill the composer with `draft` on its home view. */
  setAgentWithDraft: (agentSlug: string, draft: string) => void
  /** Replace the current view (keeps the selected agent). */
  setView: (view: AgentView) => void
  /** Read and clear the pending draft. Returns null if there isn't one. */
  consumePendingDraft: () => string | null
  /** Clear agent selection and view (back to global Home). */
  clearSelection: () => void

  handleAgentDeleted: (agentSlug: string) => void
  handleSessionDeleted: (sessionId: string) => void
  handleScheduledTaskDeleted: (taskId: string) => void
  handleWebhookTriggerDeleted: (triggerId: string) => void
  handleChatIntegrationDeleted: (integrationId: string) => void
  handleDashboardDeleted: (slug: string) => void
}

const SelectionContext = createContext<SelectionContextType | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null)
  const [view, setViewState] = useState<AgentView>(HOME)
  const [pendingDraft, setPendingDraft] = useState<string | null>(null)

  const setAgent = useCallback((agentSlug: string | null, nextView?: AgentView) => {
    setSelectedAgentSlug(agentSlug)
    setViewState(nextView ?? HOME)
  }, [])

  const setAgentWithDraft = useCallback((agentSlug: string, draft: string) => {
    setPendingDraft(draft)
    setSelectedAgentSlug(agentSlug)
    setViewState(HOME)
  }, [])

  const setView = useCallback((nextView: AgentView) => {
    setViewState(nextView)
  }, [])

  const consumePendingDraft = useCallback(() => {
    const draft = pendingDraft
    setPendingDraft(null)
    return draft
  }, [pendingDraft])

  const clearSelection = useCallback(() => {
    setSelectedAgentSlug(null)
    setViewState(HOME)
  }, [])

  const handleAgentDeleted = useCallback((agentSlug: string) => {
    setSelectedAgentSlug((current) => {
      if (current === agentSlug) {
        setViewState(HOME)
        return null
      }
      return current
    })
  }, [])

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setViewState((current) =>
      current.kind === 'session' && current.id === sessionId ? HOME : current
    )
  }, [])

  const handleScheduledTaskDeleted = useCallback((taskId: string) => {
    setViewState((current) =>
      current.kind === 'task' && current.id === taskId ? HOME : current
    )
  }, [])

  const handleWebhookTriggerDeleted = useCallback((triggerId: string) => {
    setViewState((current) =>
      current.kind === 'webhook' && current.id === triggerId ? HOME : current
    )
  }, [])

  const handleChatIntegrationDeleted = useCallback((integrationId: string) => {
    setViewState((current) =>
      current.kind === 'chat' && current.integrationId === integrationId ? HOME : current
    )
  }, [])

  const handleDashboardDeleted = useCallback((slug: string) => {
    setViewState((current) =>
      current.kind === 'dashboard' && current.slug === slug ? HOME : current
    )
  }, [])

  return (
    <SelectionContext.Provider
      value={{
        selectedAgentSlug,
        view,
        pendingDraft,
        setAgent,
        setAgentWithDraft,
        setView,
        consumePendingDraft,
        clearSelection,
        handleAgentDeleted,
        handleSessionDeleted,
        handleScheduledTaskDeleted,
        handleWebhookTriggerDeleted,
        handleChatIntegrationDeleted,
        handleDashboardDeleted,
      }}
    >
      {children}
    </SelectionContext.Provider>
  )
}

export function useSelection() {
  const context = useContext(SelectionContext)
  if (!context) {
    throw new Error('useSelection must be used within a SelectionProvider')
  }
  return context
}
