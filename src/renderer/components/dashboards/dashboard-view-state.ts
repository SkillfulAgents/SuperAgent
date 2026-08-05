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
  | { kind: 'crashed'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'ready' }

export type DashboardViewStateInput = {
  agentRunning: boolean
  artifactsLoaded: boolean
  dashboard: Pick<ArtifactInfo, 'status'> | undefined
  canStart: boolean
  startFailed: boolean
  waitElapsedMs: number
  iframeLoaded: boolean
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
    iframeLoaded,
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
    if (!iframeLoaded) {
      return waiting(slow, false)
    }
    return { kind: 'ready' }
  }

  // `starting` and queued `stopped` are both transient from outside.
  return waiting(slow, !slow)
}
