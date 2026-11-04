import { useMemo, useSyncExternalStore } from 'react'
import { getActiveTarget } from '@renderer/lib/api-target'
import {
  TEAM_BRAIN_INITIAL_STATE,
  teamBrainStateSchema,
  type TeamBrainLocationId,
  type TeamBrainPrepared,
  type TeamBrainSchedule,
  type TeamBrainState,
  type TeamBrainStep,
} from './team-brain-schema'

/**
 * The set-up modal's choices. A tiny external store (same shape as
 * use-minute-clock) lets the page and the modal read one value without a
 * provider: any write notifies every subscriber. Start chat applies them.
 *
 * A set-up in progress is also kept in localStorage, so a reload, a closed tab
 * or a quit resumes it instead of losing track of the agent and drive it made.
 * Per target: those exist on one Superagent only.
 */

const listeners = new Set<() => void>()
let current: TeamBrainState | null = null

const storageKey = () => `team-brain-setup.${getActiveTarget()}`

// Storage that throws (blocked by the browser) leaves set-up working, only not across a reload.
function saved(): TeamBrainState {
  try {
    const raw = localStorage.getItem(storageKey())
    return raw ? teamBrainStateSchema.parse(JSON.parse(raw)) : TEAM_BRAIN_INITIAL_STATE
  } catch {
    return TEAM_BRAIN_INITIAL_STATE
  }
}

function save(state: TeamBrainState) {
  try {
    if (state.status === 'off') localStorage.removeItem(storageKey())
    else localStorage.setItem(storageKey(), JSON.stringify(state))
  } catch {
    // Kept in memory only.
  }
}

function read(): TeamBrainState {
  current ??= saved()
  return current
}

function write(next: TeamBrainState) {
  current = next
  save(next)
  listeners.forEach((listener) => listener())
}

/**
 * What a restored set-up's agent is now. `launched`: its Start chat saved the
 * record before the page went. `gone`: another set-up took the record, or the
 * agent was deleted.
 */
export function restoredSetupOutcome(agentSlug: string, recordSlug: string | undefined, agentFound: boolean): 'resume' | 'launched' | 'gone' {
  if (recordSlug === agentSlug) return 'launched'
  return recordSlug || !agentFound ? 'gone' : 'resume'
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

/** Whether an agent uses Team Brain. One not switched on its own follows Every agent. */
export function usesTeamBrain(state: TeamBrainState, agentSlug: string): boolean {
  return state.agents[agentSlug] ?? state.everyAgent
}

/** The agent set-up created but the record does not mark yet, which the agent lists leave out. */
export function usePreparedTeamBrainSlug(): string | undefined {
  const select = () => read().prepared?.agentSlug ?? read().installing ?? undefined
  return useSyncExternalStore(subscribe, select, select)
}

export interface TeamBrainActions {
  /** Opt in: open the set-up modal at its first step, nothing preselected. */
  start(): void
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
  start: () => patch({ status: 'onboarding', step: 'location', location: null, prepared: null }),
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
