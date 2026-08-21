import type { ArtifactInfo } from '@renderer/hooks/use-artifacts'

export const DASHBOARD_WAIT_BOUND_MS = 120_000

export type DashboardViewState =
  | { kind: 'agent-start-failed'; message: string }
  | { kind: 'agent-no-permission'; message: string }
  | { kind: 'agent-starting'; message: string; showSpinner: true }
  | {
      kind: 'waiting'
      message: string
      showSpinner: boolean
      slow: boolean
      pollFast: boolean
    }
  | {
      kind: 'installing'
      message: string
      detail?: string
      showSpinner: boolean
      slow: boolean
      pollFast: boolean
    }
  | { kind: 'crashed'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'ready' }

export type DashboardViewStateInput = {
  agentRunning: boolean
  artifactsLoaded: boolean
  dashboard: Pick<ArtifactInfo, 'status' | 'startupPhase' | 'firstRun'> | undefined
  canStart: boolean
  startFailed: boolean
  waitElapsedMs: number
}

function waiting(slow: boolean, pollFast: boolean): Extract<DashboardViewState, { kind: 'waiting' }> {
  return {
    kind: 'waiting',
    message: slow
      ? 'Dashboard is taking longer than expected to start.'
      : 'Waiting for dashboard…',
    showSpinner: !slow,
    slow,
    pollFast,
  }
}

export function resolveDashboardViewState(input: DashboardViewStateInput): DashboardViewState {
  const {
    agentRunning,
    artifactsLoaded,
    dashboard,
    canStart,
    startFailed,
    waitElapsedMs,
  } = input

  if (!agentRunning) {
    if (startFailed) {
      return {
        kind: 'agent-start-failed',
        message: 'Agent failed to start.',
      }
    }
    if (!canStart) {
      return {
        kind: 'agent-no-permission',
        message: 'Agent is not running. Ask an admin to start it.',
      }
    }
    if (dashboard?.firstRun) {
      return {
        kind: 'installing',
        message: 'Preparing dashboard for first use…',
        detail: 'Installing dependencies. This only happens once.',
        showSpinner: true,
        slow: false,
        pollFast: true,
      }
    }
    return {
      kind: 'agent-starting',
      message: 'Starting agent…',
      showSpinner: true,
    }
  }

  const slow = waitElapsedMs >= DASHBOARD_WAIT_BOUND_MS

  if (!artifactsLoaded) {
    return waiting(slow, !slow)
  }

  if (!dashboard) {
    return { kind: 'missing', message: 'Dashboard not found.' }
  }

  if (dashboard.status === 'crashed') {
    return { kind: 'crashed', message: 'Dashboard crashed.' }
  }

  if (dashboard.status === 'running') {
    return { kind: 'ready' }
  }

  if (
    dashboard.status === 'starting'
    && dashboard.startupPhase === 'installing-dependencies'
  ) {
    if (slow) {
      return {
        kind: 'installing',
        message: 'Dependency installation is taking longer than expected.',
        showSpinner: false,
        slow: true,
        pollFast: false,
      }
    }

    return {
      kind: 'installing',
      message: dashboard.firstRun
        ? 'Preparing dashboard for first use…'
        : 'Installing dashboard dependencies…',
      ...(dashboard.firstRun
        ? { detail: 'Installing dependencies. This only happens once.' }
        : {}),
      showSpinner: true,
      slow: false,
      pollFast: true,
    }
  }

  // `starting` and queued `stopped` are both transient from outside.
  return waiting(slow, !slow)
}
