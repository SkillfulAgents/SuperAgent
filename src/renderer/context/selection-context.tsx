
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface SelectionContextType {
  selectedAgentSlug: string | null
  selectedSessionId: string | null
  selectedScheduledTaskId: string | null
  selectedWebhookTriggerId: string | null
  selectedChatIntegrationId: string | null
  selectedChatSessionId: string | null // session within a chat integration
  selectedDashboardSlug: string | null
  selectedApiLogs: boolean
  selectAgent: (agentSlug: string | null) => void
  selectSession: (sessionId: string | null) => void
  selectScheduledTask: (taskId: string | null) => void
  selectWebhookTrigger: (triggerId: string | null) => void
  selectChatIntegration: (integrationId: string | null) => void
  selectChatSession: (integrationId: string, sessionId: string) => void
  selectDashboard: (slug: string | null) => void
  selectApiLogs: (on: boolean) => void
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
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedScheduledTaskId, setSelectedScheduledTaskId] = useState<string | null>(null)
  const [selectedWebhookTriggerId, setSelectedWebhookTriggerId] = useState<string | null>(null)
  const [selectedChatIntegrationId, setSelectedChatIntegrationId] = useState<string | null>(null)
  const [selectedChatSessionId, setSelectedChatSessionId] = useState<string | null>(null)
  const [selectedDashboardSlug, setSelectedDashboardSlug] = useState<string | null>(null)
  const [selectedApiLogs, setSelectedApiLogs] = useState(false)

  const selectAgent = useCallback((agentSlug: string | null) => {
    setSelectedAgentSlug(agentSlug)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedChatIntegrationId(null)
    setSelectedChatSessionId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedSessionId(sessionId)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedChatIntegrationId(null)
    setSelectedChatSessionId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const selectScheduledTask = useCallback((taskId: string | null) => {
    setSelectedScheduledTaskId(taskId)
    setSelectedSessionId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedChatIntegrationId(null)
    setSelectedChatSessionId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const selectWebhookTrigger = useCallback((triggerId: string | null) => {
    setSelectedWebhookTriggerId(triggerId)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedChatIntegrationId(null)
    setSelectedChatSessionId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const selectChatIntegration = useCallback((integrationId: string | null) => {
    setSelectedChatIntegrationId(integrationId)
    setSelectedChatSessionId(null)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const selectChatSession = useCallback((integrationId: string, sessionId: string) => {
    setSelectedChatIntegrationId(integrationId)
    setSelectedChatSessionId(sessionId)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const selectDashboard = useCallback((slug: string | null) => {
    setSelectedDashboardSlug(slug)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedChatIntegrationId(null)
    setSelectedChatSessionId(null)
    setSelectedApiLogs(false)
  }, [])

  const selectApiLogs = useCallback((on: boolean) => {
    setSelectedApiLogs(on)
    if (on) {
      setSelectedSessionId(null)
      setSelectedScheduledTaskId(null)
      setSelectedWebhookTriggerId(null)
      setSelectedChatIntegrationId(null)
      setSelectedChatSessionId(null)
      setSelectedDashboardSlug(null)
    }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedAgentSlug(null)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
    setSelectedWebhookTriggerId(null)
    setSelectedChatIntegrationId(null)
    setSelectedChatSessionId(null)
    setSelectedDashboardSlug(null)
    setSelectedApiLogs(false)
  }, [])

  const handleAgentDeleted = useCallback((agentSlug: string) => {
    if (selectedAgentSlug === agentSlug) {
      setSelectedAgentSlug(null)
      setSelectedSessionId(null)
      setSelectedScheduledTaskId(null)
      setSelectedWebhookTriggerId(null)
      setSelectedChatIntegrationId(null)
      setSelectedChatSessionId(null)
      setSelectedDashboardSlug(null)
      setSelectedApiLogs(false)
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

  const handleChatIntegrationDeleted = useCallback((integrationId: string) => {
    if (selectedChatIntegrationId === integrationId) {
      setSelectedChatIntegrationId(null)
      setSelectedChatSessionId(null)
    }
  }, [selectedChatIntegrationId])

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
        selectedChatIntegrationId,
        selectedChatSessionId,
        selectedDashboardSlug,
        selectedApiLogs,
        selectAgent,
        selectSession,
        selectScheduledTask,
        selectWebhookTrigger,
        selectChatIntegration,
        selectChatSession,
        selectDashboard,
        selectApiLogs,
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
