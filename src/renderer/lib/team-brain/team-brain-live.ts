import { useMemo, useSyncExternalStore } from 'react'
import type { TeamBrainSourceId } from './team-brain-schema'

/**
 * What the home page shows of a running Team Brain that nothing real backs
 * yet: whether syncing is paused, when it last synced and which apps it reads.
 * Mocked and held in memory, in the same tiny external store as the set-up
 * modal's choices, until the sync itself exists. The Team Brain agent and its
 * drive are real; this is only what the page says about their syncing.
 */
export interface TeamBrainLive {
  syncPaused: boolean
  /** ISO time of the last sync. */
  lastSyncAt: string
  sources: TeamBrainSourceId[]
}

const HOUR = 60 * 60_000

/** A Team Brain that last synced two hours ago, reading the apps its sync summaries name. */
function initial(): TeamBrainLive {
  return {
    syncPaused: false,
    lastSyncAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    sources: ['slack', 'notion', 'github', 'linear', 'gmail', 'jira', 'confluence', 'googledrive', 'outlook'],
  }
}

const listeners = new Set<() => void>()
let current: TeamBrainLive = initial()

function write(next: TeamBrainLive) {
  current = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Back to a fresh mock. Used between tests. */
export function resetTeamBrainLive() {
  write(initial())
}

export function useTeamBrainLive() {
  const state = useSyncExternalStore(subscribe, () => current, () => current)
  return useMemo(
    () => ({
      state,
      setSyncPaused: (syncPaused: boolean) => write({ ...current, syncPaused }),
      setSourceConnected: (id: TeamBrainSourceId, connected: boolean) =>
        write({ ...current, sources: connected ? [...new Set([...current.sources, id])] : current.sources.filter((s) => s !== id) }),
    }),
    [state],
  )
}
