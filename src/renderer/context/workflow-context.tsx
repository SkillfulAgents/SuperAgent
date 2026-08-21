import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useRouteLocation } from '@renderer/router/use-route-location'

export interface OpenWorkflow {
  runId: string
  name?: string
}

interface WorkflowContextType {
  /** Distinct workflow runs opened/selected in the drawer this session. */
  openWorkflows: OpenWorkflow[]
  selectedRunId: string | null
  isOpen: boolean
  /** Which agent's transcript is expanded in the drawer (null = none). */
  expandedAgentId: string | null

  openWorkflow: (runId: string, name?: string) => void
  selectWorkflow: (runId: string) => void
  setExpandedAgent: (agentId: string | null) => void
  close: () => void
}

const WorkflowContext = createContext<WorkflowContextType | null>(null)

/**
 * Holds which dynamic-workflow run the side drawer is showing. Mirrors
 * FilePreviewProvider: state clears on session change, `openWorkflow` opens the
 * drawer to a run (deduping by runId). The run's actual tree/transcripts are
 * fetched from the host (tree + agent-messages routes); this only tracks selection.
 */
export function WorkflowProvider({
  children,
  sessionId: sessionIdProp,
}: {
  children: ReactNode
  sessionId?: string | null
}) {
  const { view } = useRouteLocation()
  // Views that own a session can pass it explicitly so state clears when switching
  // sessions; otherwise derive from the active route (same as FilePreviewProvider).
  const sessionId = sessionIdProp !== undefined ? sessionIdProp : view.kind === 'session' ? view.id : null

  const [openWorkflows, setOpenWorkflows] = useState<OpenWorkflow[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)

  useEffect(() => {
    setOpenWorkflows([])
    setSelectedRunId(null)
    setIsOpen(false)
    setExpandedAgentId(null)
  }, [sessionId])

  const openWorkflow = useCallback((runId: string, name?: string) => {
    setOpenWorkflows((prev) => {
      const idx = prev.findIndex((w) => w.runId === runId)
      if (idx >= 0) {
        // Backfill a name we didn't have when first opened.
        if (name && !prev[idx].name) {
          const next = [...prev]
          next[idx] = { ...next[idx], name }
          return next
        }
        return prev
      }
      return [...prev, { runId, name }]
    })
    setSelectedRunId(runId)
    setExpandedAgentId(null)
    setIsOpen(true)
  }, [])

  const selectWorkflow = useCallback((runId: string) => {
    setSelectedRunId(runId)
    setExpandedAgentId(null)
    setIsOpen(true)
  }, [])

  const setExpandedAgent = useCallback((agentId: string | null) => {
    setExpandedAgentId(agentId)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo<WorkflowContextType>(
    () => ({
      openWorkflows,
      selectedRunId,
      isOpen,
      expandedAgentId,
      openWorkflow,
      selectWorkflow,
      setExpandedAgent,
      close,
    }),
    [openWorkflows, selectedRunId, isOpen, expandedAgentId, openWorkflow, selectWorkflow, setExpandedAgent, close]
  )

  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}

export function useWorkflow(): WorkflowContextType {
  const ctx = useContext(WorkflowContext)
  if (!ctx) throw new Error('useWorkflow must be used within WorkflowProvider')
  return ctx
}
