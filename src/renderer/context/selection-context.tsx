
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface SelectionContextType {
  selectedAgentSlug: string | null
  selectedSessionId: string | null
  selectedScheduledTaskId: string | null
  selectAgent: (agentSlug: string | null) => void
  selectSession: (sessionId: string | null) => void
  selectScheduledTask: (taskId: string | null) => void
  clearSelection: () => void
  // Called when an agent is deleted - clears selection if it was selected
  handleAgentDeleted: (agentSlug: string) => void
  // Called when a session is deleted - clears selection if it was selected
  handleSessionDeleted: (sessionId: string) => void
  // Called when a scheduled task is deleted/cancelled - clears selection if it was selected
  handleScheduledTaskDeleted: (taskId: string) => void
}

const SelectionContext = createContext<SelectionContextType | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedScheduledTaskId, setSelectedScheduledTaskId] = useState<string | null>(null)

  const selectAgent = useCallback((agentSlug: string | null) => {
    setSelectedAgentSlug(agentSlug)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedSessionId(sessionId)
    setSelectedScheduledTaskId(null) // Clear scheduled task when selecting session
  }, [])

  const selectScheduledTask = useCallback((taskId: string | null) => {
    setSelectedScheduledTaskId(taskId)
    setSelectedSessionId(null) // Clear session when selecting scheduled task
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedAgentSlug(null)
    setSelectedSessionId(null)
    setSelectedScheduledTaskId(null)
  }, [])

  const handleAgentDeleted = useCallback((agentSlug: string) => {
    if (selectedAgentSlug === agentSlug) {
      setSelectedAgentSlug(null)
      setSelectedSessionId(null)
      setSelectedScheduledTaskId(null)
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

  return (
    <SelectionContext.Provider
      value={{
        selectedAgentSlug,
        selectedSessionId,
        selectedScheduledTaskId,
        selectAgent,
        selectSession,
        selectScheduledTask,
        clearSelection,
        handleAgentDeleted,
        handleSessionDeleted,
        handleScheduledTaskDeleted,
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
