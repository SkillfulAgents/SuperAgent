'use client'

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface SelectionContextType {
  selectedAgentId: string | null
  selectedSessionId: string | null
  selectAgent: (agentId: string | null) => void
  selectSession: (sessionId: string | null) => void
  clearSelection: () => void
  // Called when an agent is deleted - clears selection if it was selected
  handleAgentDeleted: (agentId: string) => void
  // Called when a session is deleted - clears selection if it was selected
  handleSessionDeleted: (sessionId: string) => void
}

const SelectionContext = createContext<SelectionContextType | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  const selectAgent = useCallback((agentId: string | null) => {
    setSelectedAgentId(agentId)
    setSelectedSessionId(null)
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedSessionId(sessionId)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedAgentId(null)
    setSelectedSessionId(null)
  }, [])

  const handleAgentDeleted = useCallback((agentId: string) => {
    if (selectedAgentId === agentId) {
      setSelectedAgentId(null)
      setSelectedSessionId(null)
    }
  }, [selectedAgentId])

  const handleSessionDeleted = useCallback((sessionId: string) => {
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null)
    }
  }, [selectedSessionId])

  return (
    <SelectionContext.Provider
      value={{
        selectedAgentId,
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
