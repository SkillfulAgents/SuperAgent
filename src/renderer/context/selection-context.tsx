
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface SelectionContextType {
  selectedAgentSlug: string | null
  selectedSessionId: string | null
  selectedScheduledTaskId: string | null
  selectedWebhookTriggerId: string | null
  selectedDashboardSlug: string | null
  selectAgent: (agentSlug: string | null) => void
  selectSession: (sessionId: string | null) => void
  selectScheduledTask: (taskId: string | null) => void
  selectWebhookTrigger: (triggerId: string | null) => void
  selectDashboard: (slug: string | null) => void
  clearSelection: () => void
  handleAgentDeleted: (agentSlug: string) => void
  handleSessionDeleted: (sessionId: string) => void
  handleScheduledTaskDeleted: (taskId: string) => void
  handleWebhookTriggerDeleted: (triggerId: string) => void
  handleDashboardDeleted: (slug: string) => void
}

const SelectionContext = createContext<SelectionContextType | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedScheduledTaskId, setSelectedScheduledTaskId] = useState<string | null>(null)
  const [selectedWebhookTriggerId, setSelectedWebhookTriggerId] = useState<string | null>(null)
  const [selectedDashboardSlug, setSelectedDashboardSlug] = useState<string | null>(null)

  const selectAgent = useCallback((agentSlug: string | null) => {
    setSelectedAgentSlug(agentSlug)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedDashboardSlug(null)
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedSessionId(sessionId)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedDashboardSlug(null)
  }, [])

  const selectScheduledTask = useCallback((taskId: string | null) => {
    setSelectedScheduledTaskId(taskId)
    setSelectedSessionId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedDashboardSlug(null)
  }, [])

  const selectWebhookTrigger = useCallback((triggerId: string | null) => {
    setSelectedWebhookTriggerId(triggerId)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedDashboardSlug(null)
  }, [])

  const selectDashboard = useCallback((slug: string | null) => {
    setSelectedDashboardSlug(slug)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedAgentSlug(null)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedDashboardSlug(null)
  }, [])

  const handleAgentDeleted = useCallback((agentSlug: string) => {
    if (selectedAgentSlug === agentSlug) {
      setSelectedAgentSlug(null)
      setSelectedSessionId(null)
      setSelectedScheduledTaskId(null)
      setSelectedWebhookTriggerId(null)
      setSelectedDashboardSlug(null)
    }
  }, [selectedAgentSlug])

  const handleSessionDeleted = useCallback((sessionId: string) => {
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null)
    }
  }, [selectedSessionId])

  const handleScheduledTaskDeleted = useCallback((taskId: string) => {
    if (selectedScheduledTaskId === taskId) {
      setSelectedScheduledTaskId(null)
    }
  }, [selectedScheduledTaskId])

  const handleWebhookTriggerDeleted = useCallback((triggerId: string) => {
    if (selectedWebhookTriggerId === triggerId) {
      setSelectedWebhookTriggerId(null)
    }
  }, [selectedWebhookTriggerId])

  const handleDashboardDeleted = useCallback((slug: string) => {
    if (selectedDashboardSlug === slug) {
      setSelectedDashboardSlug(null)
    }
  }, [selectedDashboardSlug])

  return (
    <SelectionContext.Provider
      value={{
        selectedAgentSlug,
        selectedSessionId,
        selectedScheduledTaskId,
        selectedWebhookTriggerId,
        selectedDashboardSlug,
        selectAgent,
        selectSession,
        selectScheduledTask,
        selectWebhookTrigger,
        selectDashboard,
        clearSelection,
        handleAgentDeleted,
        handleSessionDeleted,
        handleScheduledTaskDeleted,
        handleWebhookTriggerDeleted,
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
