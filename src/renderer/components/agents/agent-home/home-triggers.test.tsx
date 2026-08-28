// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { HomeTriggers } from './home-triggers'
import type { ApiScheduledTask } from '@shared/lib/types/api'

const mockUseAgentActivityStats = vi.fn()
const mockUseCompletedOneTimeSessions = vi.fn()
vi.mock('@renderer/hooks/use-activity-stats', () => ({
  useAgentActivityStats: (...args: unknown[]) => mockUseAgentActivityStats(...args),
}))

vi.mock('@renderer/hooks/use-humanized-cron', () => ({
  useHumanizedCron: () => 'Every hour',
}))

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: [] }),
  useRunScheduledTaskNow: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  useCompletedOneTimeSessions: (...args: unknown[]) => mockUseCompletedOneTimeSessions(...args),
}))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTriggers: (_slug: string, status: string) => ({
    data: status === 'active' ? [{
      id: 'webhook-a',
      agentSlug: 'agent-a',
      kind: 'custom',
      triggerType: 'CUSTOM_WEBHOOK',
      prompt: 'Handle it',
      name: 'Inbound webhook',
      status: 'active',
      fireCount: 4,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }] : [],
  }),
  useCancelWebhookTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseWebhookTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeWebhookTrigger: () => ({ mutate: vi.fn(), isPending: false }),
}))

const task: ApiScheduledTask = {
  id: 'cron-a',
  agentSlug: 'agent-a',
  scheduleType: 'cron',
  scheduleExpression: '0 * * * *',
  prompt: 'Create report',
  name: 'Hourly report',
  status: 'pending',
  nextExecutionAt: new Date('2026-07-09T13:00:00.000Z'),
  lastExecutedAt: null,
  isRecurring: true,
  executionCount: 4,
  lastSessionId: null,
  createdBySessionId: null,
  timezone: 'UTC',
  model: null,
  effort: null,
  speed: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  cancelledAt: null,
  pausedAt: null,
}

describe('HomeTriggers activity charts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseCompletedOneTimeSessions.mockReturnValue({ data: [] })
    mockUseAgentActivityStats.mockReturnValue({
      data: {
        days: 2,
        cronByTaskId: {
          'cron-a': [
            { scheduledAt: '2026-07-08T12:00:00.000Z', status: 'succeeded' },
            { scheduledAt: '2026-07-09T12:00:00.000Z', status: 'skipped' },
          ],
        },
        webhookByTriggerId: {
          'webhook-a': [
            { date: '2026-07-08', succeeded: 2, failed: 1 },
            { date: '2026-07-09', succeeded: 1, failed: 0 },
          ],
        },
        inboundXAgent: {
          total: 2,
          lastInvokedAt: '2026-07-09T11:30:00.000Z',
          activity: [
            { date: '2026-07-08', succeeded: 1, failed: 0 },
            { date: '2026-07-09', succeeded: 1, failed: 0 },
          ],
        },
        connectionById: {},
      },
    })
  })

  it('fetches one agent-scoped payload and binds each chart to its own trigger id', () => {
    renderWithProviders(<HomeTriggers
      agentSlug="agent-a"
      scheduledTasks={[task]}
      onSelectTask={vi.fn()}
      onSelectWebhook={vi.fn()}
      onSelectInboundXAgent={vi.fn()}
      onSelectCompletedTasks={vi.fn()}
    />)

    expect(mockUseAgentActivityStats).toHaveBeenCalledWith('agent-a')
    expect(screen.getByRole('img', {
      name: 'Hourly report schedule: 2 planned runs, 1 ran, 1 skipped, and 0 failed.',
    })).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Inbound webhook activity: 4 calls over 2 days, 3 succeeded and 1 failed.',
    })).toBeInTheDocument()
    expect(screen.getByText('Called from Other Agents')).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Calls from other agents: 2 calls over 2 days, 2 succeeded and 0 failed.',
    })).toBeInTheDocument()
  })

  it('reserves chart space while activity is loading so rows do not shift', () => {
    mockUseAgentActivityStats.mockReturnValue({ data: undefined, isPending: true })
    renderWithProviders(<HomeTriggers
      agentSlug="agent-a"
      scheduledTasks={[task]}
      onSelectTask={vi.fn()}
      onSelectWebhook={vi.fn()}
      onSelectInboundXAgent={vi.fn()}
      onSelectCompletedTasks={vi.fn()}
    />)

    expect(screen.getAllByTestId('activity-chart-skeleton')).toHaveLength(2)
    expect(screen.queryByRole('img', { name: /activity|schedule/i })).not.toBeInTheDocument()
  })

  it('leaves rows usable when activity is unavailable', () => {
    mockUseAgentActivityStats.mockReturnValue({ data: undefined, isError: true })
    renderWithProviders(<HomeTriggers
      agentSlug="agent-a"
      scheduledTasks={[task]}
      onSelectTask={vi.fn()}
      onSelectWebhook={vi.fn()}
      onSelectInboundXAgent={vi.fn()}
      onSelectCompletedTasks={vi.fn()}
    />)

    expect(screen.getByText('Hourly report')).toBeInTheDocument()
    expect(screen.getByText('Inbound webhook')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /activity|schedule/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('activity-chart-skeleton')).not.toBeInTheDocument()
  })

  it('shows a completed-session footer only when one-time runs exist', () => {
    const onSelectCompletedTasks = vi.fn()
    mockUseCompletedOneTimeSessions.mockReturnValue({
      data: [
        { id: 'session-a', name: 'First run', createdAt: '2026-08-24T12:00:00.000Z' },
        { id: 'session-b', name: 'Second run', createdAt: '2026-08-25T12:00:00.000Z' },
      ],
    })

    renderWithProviders(<HomeTriggers
      agentSlug="agent-a"
      scheduledTasks={[task]}
      onSelectTask={vi.fn()}
      onSelectWebhook={vi.fn()}
      onSelectInboundXAgent={vi.fn()}
      onSelectCompletedTasks={onSelectCompletedTasks}
    />)

    expect(mockUseCompletedOneTimeSessions).toHaveBeenCalledWith('agent-a')
    expect(screen.getByText('Completed (2)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'View 2 completed one-time sessions' }))
    expect(onSelectCompletedTasks).toHaveBeenCalledTimes(1)
  })
})
