// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { HomeTriggers } from './home-triggers'
import type { ApiScheduledTask } from '@shared/lib/types/api'

const mockUseAgentActivityStats = vi.fn()
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
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  cancelledAt: null,
  pausedAt: null,
}

describe('HomeTriggers activity charts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    />)

    expect(mockUseAgentActivityStats).toHaveBeenCalledWith('agent-a')
    expect(screen.getByRole('img', {
      name: 'Hourly report schedule: 2 planned runs, 1 ran, 1 skipped, and 0 failed.',
    })).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Inbound webhook activity: 4 calls over 2 days, 3 succeeded and 1 failed.',
    })).toBeInTheDocument()
  })

  it('leaves rows usable when activity is unavailable', () => {
    mockUseAgentActivityStats.mockReturnValue({ data: undefined, isError: true })
    renderWithProviders(<HomeTriggers
      agentSlug="agent-a"
      scheduledTasks={[task]}
      onSelectTask={vi.fn()}
      onSelectWebhook={vi.fn()}
    />)

    expect(screen.getByText('Hourly report')).toBeInTheDocument()
    expect(screen.getByText('Inbound webhook')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /activity|schedule/i })).not.toBeInTheDocument()
  })
})
