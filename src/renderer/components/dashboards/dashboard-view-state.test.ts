import { describe, it, expect } from 'vitest'
import {
  DASHBOARD_WAIT_BOUND_MS,
  resolveDashboardViewState,
  type DashboardViewStateInput,
} from './dashboard-view-state'

function input(overrides: Partial<DashboardViewStateInput> = {}): DashboardViewStateInput {
  return {
    agentRunning: true,
    artifactsLoaded: true,
    dashboard: { status: 'stopped' },
    canStart: true,
    startFailed: false,
    waitElapsedMs: 0,
    iframeLoaded: false,
    ...overrides,
  }
}

describe('resolveDashboardViewState', () => {
  describe('regression: transient startup must not look terminal', () => {
    it('waits with a spinner while the artifacts list has not loaded', () => {
      const state = resolveDashboardViewState(
        input({ artifactsLoaded: false, dashboard: undefined }),
      )

      expect(state).toEqual({
        kind: 'waiting',
        message: 'Waiting for dashboard…',
        showSpinner: true,
        slow: false,
        pollFast: true,
      })
    })

    it('waits with a spinner while a healthy dashboard is still queued (stopped)', () => {
      const state = resolveDashboardViewState(
        input({ dashboard: { status: 'stopped' } }),
      )

      expect(state).toEqual({
        kind: 'waiting',
        message: 'Waiting for dashboard…',
        showSpinner: true,
        slow: false,
        pollFast: true,
      })
    })
  })

  it('treats an absent dashboard as missing once the list has loaded', () => {
    const state = resolveDashboardViewState(
      input({ artifactsLoaded: true, dashboard: undefined }),
    )

    expect(state).toEqual({
      kind: 'missing',
      message: 'Dashboard not found.',
    })
  })

  it('keeps waiting (no fast poll) until the iframe has painted after status is running', () => {
    const beforePaint = resolveDashboardViewState(
      input({ dashboard: { status: 'running' }, iframeLoaded: false }),
    )
    const afterPaint = resolveDashboardViewState(
      input({ dashboard: { status: 'running' }, iframeLoaded: true }),
    )

    expect(beforePaint).toEqual({
      kind: 'waiting',
      message: 'Waiting for dashboard…',
      showSpinner: true,
      slow: false,
      pollFast: false,
    })
    expect(afterPaint).toEqual({ kind: 'ready' })
  })

  it('treats starting the same as queued: one wait label', () => {
    expect(resolveDashboardViewState(input({ dashboard: { status: 'starting' } }))).toEqual({
      kind: 'waiting',
      message: 'Waiting for dashboard…',
      showSpinner: true,
      slow: false,
      pollFast: true,
    })
  })

  it('surfaces crashed as terminal with no spinner', () => {
    expect(resolveDashboardViewState(input({ dashboard: { status: 'crashed' } }))).toEqual({
      kind: 'crashed',
      message: 'Dashboard crashed.',
    })
  })

  it.each([
    {
      condition: 'the list has not loaded',
      overrides: { artifactsLoaded: false, dashboard: undefined },
      pollFastBeforeBound: true,
    },
    {
      condition: 'the dashboard is queued',
      overrides: { dashboard: { status: 'stopped' as const } },
      pollFastBeforeBound: true,
    },
    {
      condition: 'the iframe has not loaded',
      overrides: { dashboard: { status: 'running' as const }, iframeLoaded: false },
      pollFastBeforeBound: false,
    },
  ])('acknowledges every slow wait after 120s when $condition', ({
    overrides,
    pollFastBeforeBound,
  }) => {
    expect(DASHBOARD_WAIT_BOUND_MS).toBe(120_000)
    expect(
      resolveDashboardViewState(input({ ...overrides, waitElapsedMs: 119_999 })),
    ).toEqual({
      kind: 'waiting',
      message: 'Waiting for dashboard…',
      showSpinner: true,
      slow: false,
      pollFast: pollFastBeforeBound,
    })
    expect(
      resolveDashboardViewState(input({ ...overrides, waitElapsedMs: 120_000 })),
    ).toEqual({
      kind: 'waiting',
      message: 'Dashboard is taking longer than expected to start.',
      showSpinner: false,
      slow: true,
      pollFast: false,
    })
  })

  describe('agent not running', () => {
    it('shows starting with a spinner when auto-start can proceed', () => {
      expect(
        resolveDashboardViewState(input({ agentRunning: false, dashboard: undefined })),
      ).toEqual({
        kind: 'agent-starting',
        message: 'Starting agent…',
        showSpinner: true,
      })
    })

    it('preserves the no-permission and start-failed terminals', () => {
      expect(
        resolveDashboardViewState(
          input({ agentRunning: false, canStart: false, dashboard: undefined }),
        ),
      ).toEqual({
        kind: 'agent-no-permission',
        message: 'Agent is not running. Ask an admin to start it.',
      })

      expect(
        resolveDashboardViewState(
          input({
            agentRunning: false,
            startFailed: true,
            dashboard: undefined,
          }),
        ),
      ).toEqual({
        kind: 'agent-start-failed',
        message: 'Agent failed to start.',
      })
    })
  })
})
