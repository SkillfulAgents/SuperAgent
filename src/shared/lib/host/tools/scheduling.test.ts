import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HostToolName, HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'

type MockFn = (...args: any[]) => any
const mockListPendingScheduledTasks = vi.fn<MockFn>(() => Promise.resolve([]))
const mockGetScheduledTask = vi.fn<MockFn>(() => Promise.resolve(null))
const mockCancelScheduledTask = vi.fn<MockFn>(() => Promise.resolve(true))
const mockPauseScheduledTask = vi.fn<MockFn>(() => Promise.resolve(true))
const mockResumeScheduledTask = vi.fn<MockFn>(() => Promise.resolve(true))
const mockPatchScheduledTask = vi.fn<MockFn>(() => Promise.resolve(true))
const mockCreateScheduledTask = vi.fn<MockFn>(() => Promise.resolve('task_new_id'))
const mockCreateSessionWake = vi.fn<MockFn>(() => Promise.resolve({ taskId: 'wake_new_id', replaced: null }))
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: (...args: unknown[]) => mockCreateScheduledTask(...args),
  createSessionWake: (...args: unknown[]) => mockCreateSessionWake(...args),
  listPendingScheduledTasks: (...args: unknown[]) => mockListPendingScheduledTasks(...args),
  getScheduledTask: (...args: unknown[]) => mockGetScheduledTask(...args),
  cancelScheduledTask: (...args: unknown[]) => mockCancelScheduledTask(...args),
  pauseScheduledTask: (...args: unknown[]) => mockPauseScheduledTask(...args),
  resumeScheduledTask: (...args: unknown[]) => mockResumeScheduledTask(...args),
  patchScheduledTask: (...args: unknown[]) => mockPatchScheduledTask(...args),
}))

// The real parser, unless a test makes the result formatting fail after the write.
const parser = vi.hoisted(() => ({ failFormatting: false }))
vi.mock('@shared/lib/services/schedule-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/services/schedule-parser')>()
  return {
    ...actual,
    validateScheduleExpression: (...args: Parameters<typeof actual.validateScheduleExpression>) => {
      if (parser.failFormatting) throw new Error('parser blew up')
      return actual.validateScheduleExpression(...args)
    },
  }
})

const mockResolveTimezoneForAgent = vi.fn<MockFn>(() => Promise.resolve('UTC'))
vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: (...args: unknown[]) => mockResolveTimezoneForAgent(...args),
}))

// The session owner the tools attribute to: the agent's session metadata.
const mockSessionMetadata = vi.fn<MockFn>(() => Promise.resolve(null))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (agentSlug: string) => ({
      sessions: { metadata: (sessionId: string) => mockSessionMetadata(agentSlug, sessionId) },
    }),
  },
}))

import { globalFeed } from '@shared/lib/notifications/global-feed'
import {
  cancelScheduledTaskTool,
  listScheduledTasks,
  pauseScheduledTaskTool,
  resumeScheduledTaskTool,
  scheduleResume,
  scheduleTask,
  updateScheduledTask,
} from './scheduling'

const AGENT_SLUG = 'test-agent'
const SESSION_ID = 'test-session-1'
const publish = vi.spyOn(globalFeed, 'publish')

function request(toolName: HostToolName, toolUseId: string, input: Record<string, unknown>): HostToolRequest {
  return { agentSlug: AGENT_SLUG, sessionId: SESSION_ID, toolUseId, toolName, input: JSON.stringify(input) }
}

function resolvedOf(result: HostToolResult): Extract<HostToolResult, { status: 'resolved' }> {
  if (result.status !== 'resolved') throw new Error(`Expected the tool to resolve; it rejected: ${result.reason}`)
  return result
}

function reasonOf(result: HostToolResult): string {
  if (result.status !== 'rejected') throw new Error(`Expected the tool to reject; it resolved: ${result.value}`)
  return result.reason
}

const publishedOfType = (type: string) => publish.mock.calls.map(([event]) => event).filter((event) => event.type === type)

beforeEach(() => {
  // Back to each mock's default implementation, so no test inherits another's.
  vi.resetAllMocks()
  parser.failFormatting = false
})

describe('a schedule that was written', () => {
  // The agent must never be told a persisted schedule failed: it would retry
  // and schedule the same thing twice.
  it('schedule_task resolves with its id when the result cannot be formatted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreateScheduledTask.mockResolvedValue('task_written')
    parser.failFormatting = true

    const result = await scheduleTask(request('schedule_task', 'sched-tool-x', {
      scheduleType: 'at', scheduleExpression: 'at tomorrow 9am', prompt: 'Do the thing',
    }))

    expect(resolvedOf(result).value).toContain('task_written')
    expect(publishedOfType('scheduled_task_created')).toHaveLength(1)
  })

  it('schedule_resume resolves with its id when the result cannot be formatted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreateSessionWake.mockResolvedValue({ taskId: 'wake_written', replaced: null })
    parser.failFormatting = true

    const result = await scheduleResume(request('schedule_resume', 'wake-tool-x', {
      wakeTime: 'tomorrow 9am', note: 'Check the build',
    }))

    expect(resolvedOf(result).value).toContain('wake_written')
  })
})

describe('schedule_resume', () => {
  it('creates a session wake and resolves the tool with the note echoed back', async () => {
    const result = await scheduleResume(request('schedule_resume', 'wake-tool-1', {
      wakeTime: 'at tomorrow 9am',
      note: 'Check whether Dana replied',
    }))

    expect(mockCreateSessionWake).toHaveBeenCalledWith({
      agentSlug: AGENT_SLUG,
      scheduleExpression: 'at tomorrow 9am',
      note: 'Check whether Dana replied',
      sessionId: SESSION_ID,
      createdByUserId: undefined,
      timezone: 'UTC',
    })

    const { value } = resolvedOf(result)
    expect(value).toContain('Check whether Dana replied')
    expect(value).toContain('auto-resume')
    expect(value).toContain('wake_new_id')
  })

  it('normalizes a wakeTime without the "at " prefix', async () => {
    resolvedOf(await scheduleResume(request('schedule_resume', 'wake-tool-2', {
      wakeTime: 'in 72 hours',
      note: 'Check app review status',
    })))

    expect(mockCreateSessionWake).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleExpression: 'at in 72 hours' })
    )
  })

  it('mentions the replaced wake in the tool result', async () => {
    mockCreateSessionWake.mockResolvedValue({
      taskId: 'wake_new_id',
      replaced: {
        id: 'wake_old_id',
        nextExecutionAt: new Date('2027-01-01T09:00:00.000Z'),
        prompt: 'Old note',
      },
    })

    const { value } = resolvedOf(await scheduleResume(request('schedule_resume', 'wake-tool-3', {
      wakeTime: 'at tomorrow 9am',
      note: 'New plan',
    })))

    expect(value).toContain('Replaced')
    expect(value).toContain('2027-01-01T09:00:00.000Z')
  })

  it('rejects when the note is missing', async () => {
    const result = await scheduleResume(request('schedule_resume', 'wake-tool-4', {
      wakeTime: 'at tomorrow 9am',
      note: '   ',
    }))

    expect(reasonOf(result)).toBe('Missing required fields: wakeTime and note are required')
    expect(mockCreateSessionWake).not.toHaveBeenCalled()
  })

  it('rejects when the wakeTime is missing', async () => {
    const result = await scheduleResume(request('schedule_resume', 'wake-tool-5', { note: 'A note' }))

    expect(reasonOf(result)).toBe('Missing required fields: wakeTime and note are required')
    expect(mockCreateSessionWake).not.toHaveBeenCalled()
  })

  it('rejects when wake creation fails (e.g. time in the past)', async () => {
    mockCreateSessionWake.mockRejectedValue(
      new Error('Scheduled time "at yesterday" is in the past')
    )

    const result = await scheduleResume(request('schedule_resume', 'wake-tool-6', {
      wakeTime: 'at yesterday',
      note: 'Impossible wake',
    }))

    expect(reasonOf(result)).toBe('Failed to schedule resume: Scheduled time "at yesterday" is in the past')
    expect(publish).not.toHaveBeenCalled()
  })

  it('emits scheduled_task_created then session_updated on the session stream and the global feed', async () => {
    const result = await scheduleResume(request('schedule_resume', 'wake-tool-7', {
      wakeTime: 'at tomorrow 9am',
      note: 'Check back',
    }))

    expect(resolvedOf(result).sessionEvents).toEqual([
      {
        type: 'scheduled_task_created',
        toolUseId: 'wake-tool-7',
        taskId: 'wake_new_id',
        scheduleType: 'at',
        scheduleExpression: 'at tomorrow 9am',
        agentSlug: AGENT_SLUG,
        resumeSessionId: SESSION_ID,
      },
      { type: 'session_updated' },
    ])
    expect(publish.mock.calls.map(([event]) => event)).toEqual([
      { type: 'scheduled_task_created', taskId: 'wake_new_id', agentSlug: AGENT_SLUG, resumeSessionId: SESSION_ID },
      { type: 'session_updated', sessionId: SESSION_ID, agentSlug: AGENT_SLUG },
    ])
  })

  it("attributes the wake to the session's owner", async () => {
    mockSessionMetadata.mockResolvedValue({ createdByUserId: 'user_owner' })

    resolvedOf(await scheduleResume(request('schedule_resume', 'wake-tool-8', {
      wakeTime: 'at tomorrow 9am',
      note: 'Check back',
    })))

    expect(mockSessionMetadata).toHaveBeenCalledWith(AGENT_SLUG, SESSION_ID)
    expect(mockCreateSessionWake).toHaveBeenCalledWith(expect.objectContaining({ createdByUserId: 'user_owner' }))
  })

  it("prefers the agent's explicit timezone over the owner's", async () => {
    const { value } = resolvedOf(await scheduleResume(request('schedule_resume', 'wake-tool-9', {
      wakeTime: 'at tomorrow 9am',
      note: 'Check back',
      timezone: 'America/New_York',
    })))

    expect(mockResolveTimezoneForAgent).not.toHaveBeenCalled()
    expect(mockCreateSessionWake).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/New_York' }))
    expect(value).toContain('(America/New_York)')
  })
})

describe('schedule_task', () => {
  it('persists then resolves the tool with a success message', async () => {
    const result = await scheduleTask(request('schedule_task', 'tool-sched-create-1', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
      name: 'Daily report',
    }))

    expect(mockCreateScheduledTask).toHaveBeenCalledWith({
      agentSlug: AGENT_SLUG,
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
      name: 'Daily report',
      createdBySessionId: SESSION_ID,
      createdByUserId: undefined,
      timezone: 'UTC',
      model: undefined,
      effort: undefined,
      speed: undefined,
    })

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('Daily report')
    expect(value).toContain('task_new_id')
    // Daily (well above threshold) — no frequency warning.
    expect(value).not.toContain('Frequent schedule warning')

    expect(sessionEvents).toEqual([
      {
        type: 'scheduled_task_created',
        toolUseId: 'tool-sched-create-1',
        taskId: 'task_new_id',
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * 1-5',
        name: 'Daily report',
        agentSlug: AGENT_SLUG,
      },
    ])
    expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'scheduled_task_created', taskId: 'task_new_id', agentSlug: AGENT_SLUG })
  })

  it('rejects (no false success) when persistence throws', async () => {
    mockCreateScheduledTask.mockRejectedValue(new Error('disk full'))

    const result = await scheduleTask(request('schedule_task', 'tool-sched-create-fail', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
    }))

    expect(reasonOf(result)).toBe('Failed to schedule task: disk full')
    expect(publish).not.toHaveBeenCalled()
  })

  it('appends a frequency warning for sub-threshold recurring schedules', async () => {
    const result = await scheduleTask(request('schedule_task', 'tool-sched-create-freq', {
      scheduleType: 'cron',
      scheduleExpression: '* * * * *',
      prompt: 'Poll something',
    }))

    expect(resolvedOf(result).value).toContain('Frequent schedule warning')
  })

  it('does not warn for one-time (at) schedules', async () => {
    const result = await scheduleTask(request('schedule_task', 'tool-sched-create-at', {
      scheduleType: 'at',
      scheduleExpression: 'at now + 1 hour',
      prompt: 'One-off reminder',
    }))

    expect(resolvedOf(result).value).not.toContain('Frequent schedule warning')
  })

  it('rejects when required fields are missing', async () => {
    const result = await scheduleTask(request('schedule_task', 'tool-sched-create-missing', {
      scheduleType: 'cron',
    }))

    expect(mockCreateScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toContain('Missing required fields')
  })

  it('rejects a whitespace-only prompt without persisting', async () => {
    const result = await scheduleTask(request('schedule_task', 'tool-sched-create-ws', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: '   ',
    }))

    // Container and host must agree: a blank prompt is rejected, never persisted.
    expect(mockCreateScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toContain('Missing required fields')
  })

  it('rejects input that is not JSON without persisting', async () => {
    const result = await scheduleTask({ ...request('schedule_task', 'tool-sched-create-bad', {}), input: '{"scheduleType":' })

    expect(mockCreateScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toBe('Invalid tool input')
  })

  it("attributes the task to the session's owner and honours an explicit timezone", async () => {
    mockSessionMetadata.mockResolvedValue({ createdByUserId: 'user_owner' })

    resolvedOf(await scheduleTask(request('schedule_task', 'tool-sched-create-owner', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
      timezone: 'Europe/London',
    })))

    expect(mockSessionMetadata).toHaveBeenCalledWith(AGENT_SLUG, SESSION_ID)
    expect(mockResolveTimezoneForAgent).not.toHaveBeenCalled()
    expect(mockCreateScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: 'user_owner', timezone: 'Europe/London' }),
    )
  })

  // Soft-cap (SUP-332): the result always carries the active-schedule count +
  // list; a warning is appended above the warn band and a critical warning
  // above the critical band. We never block creation.
  function makeActiveTasks(n: number): unknown[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `task_${i}`,
      name: `Task ${i}`,
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      status: 'pending',
      nextExecutionAt: new Date('2026-06-04T09:00:00Z'),
      timezone: 'America/New_York',
      prompt: 'do a thing',
    }))
  }

  it('always returns the active-schedule count and list with no warning at or below the warn band', async () => {
    mockListPendingScheduledTasks.mockResolvedValue(makeActiveTasks(4))

    const { value } = resolvedOf(await scheduleTask(request('schedule_task', 'tool-sched-band-ok', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
    })))

    expect(mockListPendingScheduledTasks).toHaveBeenCalledWith(AGENT_SLUG)
    expect(value).toContain('Active schedules for this agent: 4')
    expect(value).toContain('task_0') // full list is present
    expect(value).toContain('task_3')
    expect(value).not.toContain('Schedule count warning')
    expect(value).not.toContain('CRITICAL')
  })

  it('appends a (non-critical) warning above the warn band', async () => {
    mockListPendingScheduledTasks.mockResolvedValue(makeActiveTasks(5))

    const { value } = resolvedOf(await scheduleTask(request('schedule_task', 'tool-sched-band-warn', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
    })))

    expect(value).toContain('Active schedules for this agent: 5')
    expect(value).toContain('Schedule count warning')
    expect(value).not.toContain('CRITICAL')
    expect(value).toContain('task_4') // full list still included
  })

  it('appends a critical warning above the critical band', async () => {
    mockListPendingScheduledTasks.mockResolvedValue(makeActiveTasks(7))

    const { value } = resolvedOf(await scheduleTask(request('schedule_task', 'tool-sched-band-crit', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
    })))

    expect(value).toContain('Active schedules for this agent: 7')
    expect(value).toContain('CRITICAL')
  })

  it('still resolves with the base success when the active-list lookup fails', async () => {
    // Enrichment is best-effort: a failure reading the active list must not
    // turn the already-persisted task into a failure the agent would retry.
    mockListPendingScheduledTasks.mockRejectedValue(new Error('db unavailable'))

    const result = await scheduleTask(request('schedule_task', 'tool-sched-band-fail', {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      prompt: 'Send the daily report',
    }))

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('task_new_id') // base success preserved
    expect(value).not.toContain('Active schedules for this agent') // enrichment skipped
    expect(sessionEvents).toEqual([expect.objectContaining({ type: 'scheduled_task_created', taskId: 'task_new_id' })])
  })
})

describe('list_scheduled_tasks', () => {
  it('resolves with a formatted task list', async () => {
    mockListPendingScheduledTasks.mockResolvedValue([
      {
        id: 'task_1', name: 'Daily report', scheduleType: 'cron',
        scheduleExpression: '0 9 * * 1-5', status: 'pending',
        nextExecutionAt: new Date('2026-06-04T09:00:00Z'), timezone: 'America/New_York',
        prompt: 'Send the daily report',
      },
      {
        id: 'task_2', name: null, scheduleType: 'at',
        scheduleExpression: 'at tomorrow 9am', status: 'paused',
        nextExecutionAt: new Date('2026-06-04T13:00:00Z'), timezone: null,
        prompt: 'One-off reminder',
      },
    ])

    const result = await listScheduledTasks(request('list_scheduled_tasks', 'tool-sched-list-1', {}))

    expect(mockListPendingScheduledTasks).toHaveBeenCalledWith(AGENT_SLUG)
    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('task_1')
    expect(value).toContain('Daily report')
    expect(value).toContain('0 9 * * 1-5')
    expect(value).toContain('America/New_York')
    expect(value).toContain('[PAUSED]')
    // A read changes nothing anyone else shows.
    expect(sessionEvents).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
  })

  it('resolves with empty message when no tasks', async () => {
    mockListPendingScheduledTasks.mockResolvedValue([])

    const result = await listScheduledTasks(request('list_scheduled_tasks', 'tool-sched-list-empty', {}))

    expect(resolvedOf(result).value).toContain('No scheduled tasks')
  })
})

describe('update_scheduled_task', () => {
  it('updates schedule and prompt in one mutation and preserves the task ID', async () => {
    mockGetScheduledTask.mockResolvedValue({
      id: 'task_existing',
      agentSlug: AGENT_SLUG,
      scheduleType: 'cron',
      scheduleExpression: '0 18 * * *',
      timezone: 'UTC',
      nextExecutionAt: new Date('2026-06-04T18:00:00Z'),
    })

    const result = await updateScheduledTask(request('update_scheduled_task', 'tool-sched-update-1', {
      task_id: 'task_existing',
      schedule_expression: '0 18 * * *',
      prompt: 'Send the revised report',
    }))

    expect(mockPatchScheduledTask).toHaveBeenCalledWith('task_existing', {
      scheduleExpression: '0 18 * * *',
      prompt: 'Send the revised report',
    })
    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('execution history were preserved')
    expect(sessionEvents).toEqual([
      { type: 'scheduled_task_updated', toolUseId: 'tool-sched-update-1', taskId: 'task_existing', agentSlug: AGENT_SLUG },
    ])
    expect(publishedOfType('scheduled_task_updated')).toEqual([
      { type: 'scheduled_task_updated', taskId: 'task_existing', agentSlug: AGENT_SLUG },
    ])
  })

  it('rejects an expression that does not match the existing schedule type', async () => {
    mockGetScheduledTask.mockResolvedValue({
      id: 'task_existing',
      agentSlug: AGENT_SLUG,
      scheduleType: 'cron',
      timezone: 'UTC',
    })

    const result = await updateScheduledTask(request('update_scheduled_task', 'tool-sched-update-invalid', {
      task_id: 'task_existing',
      schedule_expression: 'at tomorrow 9am',
    }))

    expect(mockPatchScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toContain('Invalid cron schedule expression')
  })

  it('does not update a task owned by another agent', async () => {
    mockGetScheduledTask.mockResolvedValue({
      id: 'task_foreign',
      agentSlug: 'other-agent',
      scheduleType: 'cron',
    })

    const result = await updateScheduledTask(request('update_scheduled_task', 'tool-sched-update-foreign', {
      task_id: 'task_foreign',
      prompt: 'Take over this task',
    }))

    expect(mockPatchScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toBe('Scheduled task task_foreign not found')
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('cancel_scheduled_task', () => {
  it('emits scheduled_task_cancelled on success', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_existing', agentSlug: AGENT_SLUG })

    const result = await cancelScheduledTaskTool(request('cancel_scheduled_task', 'tool-sched-cancel-1', {
      task_id: 'task_existing',
    }))

    expect(mockCancelScheduledTask).toHaveBeenCalledWith('task_existing')

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('has been cancelled')
    expect(sessionEvents).toEqual([
      { type: 'scheduled_task_cancelled', toolUseId: 'tool-sched-cancel-1', taskId: 'task_existing', agentSlug: AGENT_SLUG },
    ])
    expect(publishedOfType('scheduled_task_cancelled')).toEqual([
      { type: 'scheduled_task_cancelled', taskId: 'task_existing', agentSlug: AGENT_SLUG },
    ])
  })

  it('rejects when task belongs to a different agent', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_other', agentSlug: 'someone-else' })

    const result = await cancelScheduledTaskTool(request('cancel_scheduled_task', 'tool-sched-cancel-foreign', {
      task_id: 'task_other',
    }))

    expect(mockCancelScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toContain('not found')
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects when the task cannot be cancelled (already executed/cancelled)', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_done', agentSlug: AGENT_SLUG })
    mockCancelScheduledTask.mockResolvedValue(false)

    const result = await cancelScheduledTaskTool(request('cancel_scheduled_task', 'tool-sched-cancel-done', {
      task_id: 'task_done',
    }))

    expect(reasonOf(result)).toContain('could not be cancelled')
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects when task_id is missing', async () => {
    const result = await cancelScheduledTaskTool(request('cancel_scheduled_task', 'tool-sched-cancel-noid', {}))

    expect(reasonOf(result)).toContain('Missing required field')
    expect(mockGetScheduledTask).not.toHaveBeenCalled()
  })
})

describe('pause_scheduled_task', () => {
  it('emits scheduled_task_updated on success', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_cron', agentSlug: AGENT_SLUG })

    const result = await pauseScheduledTaskTool(request('pause_scheduled_task', 'tool-sched-pause-1', {
      task_id: 'task_cron',
    }))

    expect(mockPauseScheduledTask).toHaveBeenCalledWith('task_cron')

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('has been paused')
    expect(sessionEvents).toEqual([
      { type: 'scheduled_task_updated', toolUseId: 'tool-sched-pause-1', taskId: 'task_cron', agentSlug: AGENT_SLUG },
    ])
    expect(publishedOfType('scheduled_task_updated')).toEqual([
      { type: 'scheduled_task_updated', taskId: 'task_cron', agentSlug: AGENT_SLUG },
    ])
  })

  it('rejects when the task cannot be paused (not an active recurring task)', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_at', agentSlug: AGENT_SLUG })
    mockPauseScheduledTask.mockResolvedValue(false)

    const result = await pauseScheduledTaskTool(request('pause_scheduled_task', 'tool-sched-pause-bad', {
      task_id: 'task_at',
    }))

    expect(reasonOf(result)).toContain('could not be paused')
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects when task belongs to a different agent', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_other', agentSlug: 'someone-else' })

    const result = await pauseScheduledTaskTool(request('pause_scheduled_task', 'tool-sched-pause-foreign', {
      task_id: 'task_other',
    }))

    expect(mockPauseScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toContain('not found')
  })
})

describe('resume_scheduled_task', () => {
  it('emits scheduled_task_updated on success', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_paused', agentSlug: AGENT_SLUG })

    const result = await resumeScheduledTaskTool(request('resume_scheduled_task', 'tool-sched-resume-1', {
      task_id: 'task_paused',
    }))

    expect(mockResumeScheduledTask).toHaveBeenCalledWith('task_paused')

    const { value, sessionEvents } = resolvedOf(result)
    expect(value).toContain('has been resumed')
    expect(sessionEvents).toEqual([
      { type: 'scheduled_task_updated', toolUseId: 'tool-sched-resume-1', taskId: 'task_paused', agentSlug: AGENT_SLUG },
    ])
    expect(publishedOfType('scheduled_task_updated')).toEqual([
      { type: 'scheduled_task_updated', taskId: 'task_paused', agentSlug: AGENT_SLUG },
    ])
  })

  it('rejects when the task cannot be resumed (not paused)', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_active', agentSlug: AGENT_SLUG })
    mockResumeScheduledTask.mockResolvedValue(false)

    const result = await resumeScheduledTaskTool(request('resume_scheduled_task', 'tool-sched-resume-bad', {
      task_id: 'task_active',
    }))

    expect(reasonOf(result)).toContain('could not be resumed')
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not resume a task owned by another agent', async () => {
    mockGetScheduledTask.mockResolvedValue({ id: 'task_other', agentSlug: 'someone-else' })

    const result = await resumeScheduledTaskTool(request('resume_scheduled_task', 'tool-sched-resume-foreign', {
      task_id: 'task_other',
    }))

    expect(mockResumeScheduledTask).not.toHaveBeenCalled()
    expect(reasonOf(result)).toBe('Scheduled task task_other not found')
  })
})
