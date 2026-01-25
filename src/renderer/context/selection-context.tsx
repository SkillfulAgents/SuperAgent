
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface SelectionContextType {
  selectedAgentSlug: string | null
  selectedSessionId: string | null
  selectAgent: (agentSlug: string | null) => void
  selectSession: (sessionId: string | null) => void
  clearSelection: () => void
  // Called when an agent is deleted - clears selection if it was selected
  handleAgentDeleted: (agentSlug: string) => void
  // Called when a session is deleted - clears selection if it was selected
  handleSessionDeleted: (sessionId: string) => void
}

const SelectionContext = createContext<SelectionContextType | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  const selectAgent = useCallback((agentSlug: string | null) => {
    setSelectedAgentSlug(agentSlug)
    setSelectedSessionId(null)
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedSessionId(sessionId)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedAgentSlug(null)
    setSelectedSessionId(null)
  }, [])

  const handleAgentDeleted = useCallback((agentSlug: string) => {
    if (selectedAgentSlug === agentSlug) {
      setSelectedAgentSlug(null)
      setSelectedSessionId(null)
    }
  }, [selectedAgentSlug])

  const handleSessionDeleted = useCallback((sessionId: string) => {
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null)
    }
  }, [selectedSessionId])

  return (
    <SelectionContext.Provider
      value={{
        selectedAgentSlug,
        selectedSessionId,
        selectAgent,
        selectSession,
        clearSelection,
        handleAgentDeleted,
        handleSessionDeleted,
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
