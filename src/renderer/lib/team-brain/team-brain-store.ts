import { useMemo, useSyncExternalStore } from 'react'
import type { TeamBrainChoices, TeamBrainStep } from '@shared/lib/config/team-brain-schema'

/**
 * The set-up window, in memory: whether it is open and which step it shows.
 * The set-up itself (its agent, drive and choices) lives on the server. A tiny
 * external store (same shape as use-minute-clock) lets the page and the window
 * read one value without a provider.
 */

/** `off` (the page) → `onboarding` (the set-up window open) → `launching` (after Start chat). */
export interface TeamBrainWindowState {
  status: 'off' | 'onboarding' | 'launching'
  step: TeamBrainStep
  /** The agent step 1 just installed, until the set-up records it: the agent lists leave it out meanwhile. */
  installing: string | null
}

const CLOSED: TeamBrainWindowState = { status: 'off', step: 'location', installing: null }

const listeners = new Set<() => void>()
let current: TeamBrainWindowState = CLOSED

function read(): TeamBrainWindowState {
  return current
}

function write(next: TeamBrainWindowState) {
  current = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Read the window outside React (tests, handlers). */
export function getTeamBrainState(): TeamBrainWindowState {
  return read()
}

/** Back to closed. Used between tests. */
export function resetTeamBrainState() {
  write(CLOSED)
}

/** The agent set-up installed but has not recorded yet, which the agent lists leave out. */
export function useInstallingTeamBrainSlug(): string | null {
  const select = () => read().installing
  return useSyncExternalStore(subscribe, select, select)
}

/** Whether an agent uses Team Brain. One not switched on its own follows Every agent. */
export function usesTeamBrain(choices: Pick<TeamBrainChoices, 'agents' | 'everyAgent'>, agentSlug: string): boolean {
  return choices.agents[agentSlug] ?? choices.everyAgent
}

export interface TeamBrainActions {
  /** Open the set-up window at `step`. */
  open(step: TeamBrainStep): void
  /** Close the window. The set-up stays on the server. */
  close(): void
  goToStep(step: TeamBrainStep): void
  /** Start chat closes the window while it runs; a failed Start chat reopens it. */
  setLaunching(launching: boolean): void
  setInstalling(agentSlug: string | null): void
}

export interface TeamBrainStore extends TeamBrainActions {
  state: TeamBrainWindowState
  isOnboarding: boolean
}

const actions: TeamBrainActions = {
  open: (step) => write({ ...read(), status: 'onboarding', step }),
  // Keeps the step: the window still shows it while it fades out.
  close: () => write({ ...read(), status: 'off' }),
  goToStep: (step) => write({ ...read(), step }),
  setLaunching: (launching) => write({ ...read(), status: launching ? 'launching' : 'onboarding' }),
  setInstalling: (installing) => write({ ...read(), installing }),
}

export function useTeamBrain(): TeamBrainStore {
  const state = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => ({ state, isOnboarding: state.status === 'onboarding', ...actions }), [state])
}
