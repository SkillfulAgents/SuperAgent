import { useMemo, useSyncExternalStore } from 'react'
import {
  TEAM_BRAIN_INITIAL_STATE,
  type TeamBrainAgentAccess,
  type TeamBrainLocationId,
  type TeamBrainSchedule,
  type TeamBrainState,
  type TeamBrainStep,
} from './team-brain-schema'

/**
 * The set-up modal's choices, in memory. A tiny external store (same shape as
 * use-minute-clock) lets the page and the modal read one value without a
 * provider: any write notifies every subscriber. Nothing is saved yet; the
 * set-up chat that uses these choices is where they will be persisted.
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

/** What an agent may do with Team Brain. Everyone reads and writes until set otherwise. */
export function agentAccessOf(state: TeamBrainState, agentSlug: string): TeamBrainAgentAccess {
  return state.agentAccess[agentSlug] ?? 'both'
}

export interface TeamBrainActions {
  /** Opt in: open the set-up modal at its first step, nothing preselected. */
  start(): void
  /** Leave set-up. Nothing is kept. */
  cancelSetup(): void
  goToStep(step: TeamBrainStep): void
  setLocation(id: TeamBrainLocationId): void
  setSchedule(schedule: TeamBrainSchedule): void
  setAgentAccess(agentSlug: string, access: TeamBrainAgentAccess): void
}

export interface TeamBrainStore extends TeamBrainActions {
  state: TeamBrainState
  isOnboarding: boolean
}

const actions: TeamBrainActions = {
  start: () => patch({ status: 'onboarding', step: 'location', location: null }),
  cancelSetup: () => write(TEAM_BRAIN_INITIAL_STATE),
  goToStep: (step) => patch({ step }),
  setLocation: (location) => patch({ location }),
  setSchedule: (schedule) => patch({ schedule }),
  setAgentAccess: (agentSlug, access) => patch({ agentAccess: { ...read().agentAccess, [agentSlug]: access } }),
}

export function useTeamBrain(): TeamBrainStore {
  const state = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => ({ state, isOnboarding: state.status === 'onboarding', ...actions }), [state])
}
