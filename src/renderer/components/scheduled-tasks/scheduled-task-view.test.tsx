// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderWithProviders, screen, userEvent, waitFor } from '@renderer/test/test-utils'
import type { ApiScheduledTask } from '@shared/lib/types/api'

const mockSetView = vi.fn()
const mockHandleScheduledTaskDeleted = vi.fn()
const mockUpdateScheduledTaskName = vi.fn()
const mockCancelScheduledTask = vi.fn()
let mockCanUseAgent = true
let mockTask: ApiScheduledTask

vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({
    selectedAgentSlug: 'agent-one',
    view: { kind: 'task', id: 'task-1' },
    setView: mockSetView,
    handleScheduledTaskDeleted: mockHandleScheduledTaskDeleted,
  }),
  SelectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canUseAgent: () => mockCanUseAgent,
  }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/hooks/use-humanized-cron', () => ({
  useHumanizedCron: () => 'Every day at 9:00 AM',
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      llmProvider: 'anthropic',
      models: { agentModel: 'sonnet' },
      llmProviderStatus: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          isConfigured: true,
          catalog: [
            { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high'] },
          ],
          defaultModels: { agent: 'sonnet', summarizer: 'haiku', browser: 'sonnet' },
        },
      ],
    },
  }),
}))

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTask: () => ({ data: mockTask, isLoading: false, error: null }),
  useScheduledTaskSessions: () => ({ data: [] }),
  useCancelScheduledTask: () => ({ mutateAsync: mockCancelScheduledTask, isPending: false }),
  useUpdateScheduledTaskTimezone: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunScheduledTaskNow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePauseScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateScheduledTaskPrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateScheduledTaskName: () => ({
    mutateAsync: mockUpdateScheduledTaskName,
    isPending: false,
  }),
  useUpdateScheduledTaskRuntimeOptions: () => ({ mutate: vi.fn(), isPending: false }),
  useDescribeSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useParseSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

import { ScheduledTaskView } from './scheduled-task-view'

function createTask(overrides: Partial<ApiScheduledTask> = {}): ApiScheduledTask {
  return {
    id: 'task-1',
    agentSlug: 'agent-one',
    scheduleType: 'cron',
    scheduleExpression: '0 9 * * *',
    prompt: 'Summarize yesterday',
    name: 'Daily report',
    status: 'pending',
    nextExecutionAt: new Date('2026-06-16T16:00:00.000Z'),
    lastExecutedAt: null,
    isRecurring: true,
    executionCount: 0,
    lastSessionId: null,
    createdBySessionId: null,
    timezone: 'UTC',
    model: null,
    effort: null,
    createdAt: new Date('2026-06-15T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

describe('ScheduledTaskView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTask = createTask()
    mockCanUseAgent = true
    mockUpdateScheduledTaskName.mockResolvedValue(createTask({ name: 'Weekly report' }))
  })

  it('renames the cron inline from the title', async () => {
    const user = userEvent.setup()

    renderWithProviders(<ScheduledTaskView taskId="task-1" agentSlug="agent-one" />)

    await user.click(screen.getByTestId('scheduled-task-title'))
    await user.clear(screen.getByTestId('scheduled-task-title-input'))
    await user.type(screen.getByTestId('scheduled-task-title-input'), 'Weekly report')
    await user.click(screen.getByTestId('scheduled-task-title-save'))

    await waitFor(() => {
      expect(mockUpdateScheduledTaskName).toHaveBeenCalledWith({
        taskId: 'task-1',
        agentSlug: 'agent-one',
        name: 'Weekly report',
      })
    })
  })

  it('does not show rename in the gear menu', async () => {
    const user = userEvent.setup()

    renderWithProviders(<ScheduledTaskView taskId="task-1" agentSlug="agent-one" />)

    await user.click(screen.getByRole('button', { name: 'Cron settings' }))

    expect(screen.queryByText('Rename Cron')).not.toBeInTheDocument()
    expect(screen.getByText('Edit Schedule')).toBeInTheDocument()
  })
})
