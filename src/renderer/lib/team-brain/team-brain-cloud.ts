import { useMemo, useSyncExternalStore } from 'react'
import type { TeamBrainLocationId, TeamBrainSchedule, TeamBrainSourceId } from './team-brain-schema'

/**
 * Team Brain on the desktop (prototype). An organization's Team Brain is set up once, in its cloud workspace. The
 * desktop app, driving the Superagent on someone's own computer, can connect to that one, read-only, for the agents on
 * this computer, or set up one of its own, independent of the cloud's: set-up's two paths (`teamBrainSteps`). Finding
 * the cloud workspace is real (`useCloudTeamBrain`); what it says about its Team Brain (`team-brain-cloud-fixture.ts`)
 * and the connection below are held in memory until the workspace can be asked. Nothing is saved: a reload starts over.
 */

/** What the cloud workspace says about its Team Brain. */
export interface CloudTeamBrain {
  /** The cloud workspace it is in, by its address. */
  workspace: string
  location: TeamBrainLocationId
  /** Where in its home, as a drive row says it ("Shared drives / Team Brain"). */
  place: string
  schedule: TeamBrainSchedule
  sources: readonly TeamBrainSourceId[]
  /** How many pages it holds, without its own record. */
  pages: number
  lastSyncAt: string
}

export interface CloudConnectState {
  /** The Team Brain this computer reads, once connected. */
  connected: { brain: CloudTeamBrain; at: string } | null
  /** Which agents on this computer read it, by slug. An agent not listed does. */
  agents: Record<string, boolean>
  /** Every agent here, including ones made later. */
  everyAgent: boolean
}

const INITIAL: CloudConnectState = { connected: null, agents: {}, everyAgent: false }

// The same tiny external store as team-brain-store.ts: any write notifies every subscriber.
const listeners = new Set<() => void>()
let current: CloudConnectState = INITIAL

function write(next: CloudConnectState) {
  current = next
  listeners.forEach((listener) => listener())
}

function patch(changes: Partial<CloudConnectState>) {
  write({ ...current, ...changes })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const read = () => current

/** Read the current state outside React (tests, handlers). */
export function getCloudConnection(): CloudConnectState {
  return current
}

/** Replace the state wholesale. For tests. */
export function setCloudConnection(next: CloudConnectState) {
  write(next)
}

/** Back to not connected. Used between tests. */
export function resetCloudConnection() {
  write(INITIAL)
}

/** Whether an agent here reads the cloud's Team Brain. Every agent does until switched off. */
export function readsCloudBrain(state: CloudConnectState, agentSlug: string): boolean {
  return state.everyAgent || (state.agents[agentSlug] ?? true)
}

export interface CloudConnectActions {
  /** Connect, for the agents chosen in set-up (an agent not listed reads it), or every agent. */
  connect(brain: CloudTeamBrain, readers: Pick<CloudConnectState, 'agents' | 'everyAgent'>): void
  setReads(agentSlug: string, on: boolean): void
  setEveryAgent(on: boolean): void
  disconnect(): void
}

const actions: CloudConnectActions = {
  connect: (brain, { agents, everyAgent }) => write({ connected: { brain, at: new Date().toISOString() }, agents, everyAgent }),
  setReads: (agentSlug, on) => patch({ agents: { ...current.agents, [agentSlug]: on } }),
  setEveryAgent: (everyAgent) => patch({ everyAgent }),
  disconnect: () => write(INITIAL),
}

export function useCloudConnection(): CloudConnectActions & { state: CloudConnectState } {
  const state = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => ({ state, ...actions }), [state])
}
