import { useMemo, useSyncExternalStore } from 'react'
import {
  TEAM_BRAIN_INITIAL_STATE,
  type TeamBrainLocationId,
  type TeamBrainPath,
  type TeamBrainPrepared,
  type TeamBrainSchedule,
  type TeamBrainState,
  type TeamBrainStep,
} from './team-brain-schema'

/**
 * The set-up modal's choices, in memory. A tiny external store (same shape as
 * use-minute-clock) lets the page and the modal read one value without a
 * provider: any write notifies every subscriber. Start chat applies them.
 */

const listeners = new Set<() => void>()
let current: TeamBrainState = TEAM_BRAIN_INITIAL_STATE

function read(): TeamBrainState {
  return current
}

function write(next: TeamBrainState) {
  current = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function patch(changes: Partial<TeamBrainState>) {
  write({ ...read(), ...changes })
}

/** Read the current state outside React (tests, handlers). */
export function getTeamBrainState(): TeamBrainState {
  return read()
}

/** Replace the state wholesale. For tests. */
export function setTeamBrainState(next: TeamBrainState) {
  write(next)
}

/** Back to the start. Used between tests. */
export function resetTeamBrainState() {
  write(TEAM_BRAIN_INITIAL_STATE)
}

/** Whether an agent uses Team Brain. Every agent does until turned off. */
export function usesTeamBrain(state: TeamBrainState, agentSlug: string): boolean {
  return state.agents[agentSlug] ?? true
}

/** The agent set-up created but the record does not mark yet, which the agent lists leave out. */
export function usePreparedTeamBrainSlug(): string | undefined {
  const select = () => read().prepared?.agentSlug ?? read().installing ?? undefined
  return useSyncExternalStore(subscribe, select, select)
}

export interface TeamBrainActions {
  /** Opt in: open the set-up modal at its first step, nothing preselected. */
  start(): void
  choosePath(path: TeamBrainPath): void
  /** Leave set-up. Nothing is kept; the caller discards what was prepared. */
  cancelSetup(): void
  goToStep(step: TeamBrainStep): void
  setLocation(id: TeamBrainLocationId): void
  setPrepared(prepared: TeamBrainPrepared | null): void
  setInstalling(agentSlug: string | null): void
  /** Start chat closes the modal while the prepared agent launches; a failed launch reopens it. */
  setLaunching(launching: boolean): void
  setSchedule(schedule: TeamBrainSchedule): void
  setUsesTeamBrain(agentSlug: string, on: boolean): void
  setEveryAgent(on: boolean): void
}

export interface TeamBrainStore extends TeamBrainActions {
  state: TeamBrainState
  isOnboarding: boolean
}

const actions: TeamBrainActions = {
  start: () => patch({ status: 'onboarding', step: 'location', path: null, location: null, prepared: null }),
  // Chosen on how, so set-up stays there until Next.
  choosePath: (path) => patch({ path, step: 'how' }),
  cancelSetup: () => write(TEAM_BRAIN_INITIAL_STATE),
  goToStep: (step) => patch({ step }),
  setLocation: (location) => patch({ location }),
  setPrepared: (prepared) => patch({ prepared, installing: null }),
  setInstalling: (installing) => patch({ installing }),
  setLaunching: (launching) => patch({ status: launching ? 'launching' : 'onboarding' }),
  setSchedule: (schedule) => patch({ schedule }),
  setUsesTeamBrain: (agentSlug, on) => patch({ agents: { ...read().agents, [agentSlug]: on } }),
  setEveryAgent: (everyAgent) => patch({ everyAgent }),
}

export function useTeamBrain(): TeamBrainStore {
  const state = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => ({ state, isOnboarding: state.status === 'onboarding', ...actions }), [state])
}
