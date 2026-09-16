import { useState } from 'react'
import { useAgents, useStopAgent } from './use-agents'

export interface StaleAgentRow {
  slug: string
  name: string
  /** Mid-turn: a stop ends the turn. Shown as a marker, never a skip. */
  working: boolean
}

/**
 * Agents the host marked stale (still running on a container env that a
 * setting change replaced), read off the agent list, and one Stop all built on
 * the sidebar's own stop. Each stop clears the mark through its own status
 * event, so the list keeps up without any refetch of its own.
 */
export function useStaleAgents() {
  const { data: agents = [] } = useAgents()
  const stopAgent = useStopAgent()
  const [run, setRun] = useState({ pending: false, stopped: 0 })

  const rows: StaleAgentRow[] = agents
    .filter((a) => a.stale)
    .map((a) => ({ slug: a.slug, name: a.name, working: a.hasActiveSessions === true }))

  // Every listed agent's own stop, all at once. A failed one stays listed.
  const stopAll = async () => {
    setRun({ pending: true, stopped: 0 })
    const results = await Promise.allSettled(rows.map((r) => stopAgent.mutateAsync(r.slug)))
    setRun({ pending: false, stopped: results.filter((r) => r.status === 'fulfilled').length })
  }

  return {
    rows,
    stopAll,
    isStopping: run.pending,
    /** How many the stop this mount asked for took down. Feedback, not state: gone on remount. */
    stoppedCount: run.stopped,
  }
}
