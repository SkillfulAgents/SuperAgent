/**
 * The scheduling host tools: schedule a task or a session wake, and list,
 * update, cancel, pause and resume the agent's schedules.
 *
 * Every tool checks that a task it touches belongs to the calling agent, so
 * one agent cannot act on another's schedules by guessing ids.
 */
import type { HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import {
  cancelScheduledTask,
  createScheduledTask,
  createSessionWake,
  getScheduledTask,
  listPendingScheduledTasks,
  patchScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  type ScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import { updateScheduledTaskInputSchema, type ScheduledTaskUpdateInput } from '@shared/lib/services/automation-update-schema'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { getFrequencyWarning, getScheduleCountWarning, validateScheduleExpression } from '@shared/lib/services/schedule-parser'
import { errorMessage, parseToolInput, rejected, resolved, sessionOwnerOf } from './host-tool-result'

interface ScheduleTaskInput {
  scheduleType: 'at' | 'cron'
  scheduleExpression: string
  prompt: string
  name?: string
  timezone?: string
  model?: string
  effort?: string
  speed?: string
}

/**
 * Persist a scheduled task. The tool succeeds only once the task is saved,
 * so the agent is never told a false success; once it is saved, the tool
 * never fails, or the agent could retry into a duplicate schedule.
 */
export async function scheduleTask({ agentSlug, sessionId, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  const input = parseToolInput<ScheduleTaskInput>(raw)
  if (input === undefined) {
    console.error('[HostTools] Failed to parse schedule task input:', raw)
    return rejected('Invalid tool input')
  }
  // Trim-aware, matching the container tool's own validation: a
  // whitespace-only prompt or expression is empty, and the container already
  // told the agent such a call was rejected.
  if (!input.scheduleType || !input.scheduleExpression?.trim() || !input.prompt?.trim()) {
    return rejected('Missing required fields: scheduleType, scheduleExpression, and prompt are required')
  }

  let taskId: string
  let timezone: string | undefined
  try {
    // An explicit timezone from the agent wins over the agent owner's.
    timezone = input.timezone || (await resolveTimezoneForAgent(agentSlug))
    taskId = await createScheduledTask({
      agentSlug,
      scheduleType: input.scheduleType,
      scheduleExpression: input.scheduleExpression,
      prompt: input.prompt,
      name: input.name,
      createdBySessionId: sessionId,
      createdByUserId: await sessionOwnerOf(agentSlug, sessionId),
      timezone,
      model: input.model,
      effort: input.effort,
      speed: input.speed,
    })
  } catch (error) {
    console.error('[HostTools] Error handling schedule task:', error)
    return rejected(`Failed to schedule task: ${errorMessage(error)}`)
  }

  globalFeed.publish({ type: 'scheduled_task_created', taskId, agentSlug })

  // The agent's active schedules ride along, so a runaway loop or a duplicate
  // is visible to it. Best-effort: without them the base result still goes.
  let result = persistedResult(taskId, () => formatScheduleTaskResult(input, taskId, timezone))
  try {
    result += formatActiveScheduleSummary(await listPendingScheduledTasks(agentSlug))
  } catch (summaryError) {
    console.error('[HostTools] Failed to build active-schedule summary:', summaryError)
  }
  return resolved(result, [
    {
      type: 'scheduled_task_created',
      toolUseId,
      taskId,
      scheduleType: input.scheduleType,
      scheduleExpression: input.scheduleExpression,
      name: input.name,
      agentSlug,
    },
  ])
}

/**
 * Persist a session wake: a one-shot scheduled task that resumes THIS
 * session instead of starting a new one. Same contract as `scheduleTask`.
 */
export async function scheduleResume({ agentSlug, sessionId, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  const input = parseToolInput<{ wakeTime?: string; note?: string; timezone?: string }>(raw)
  if (input === undefined) {
    console.error('[HostTools] Failed to parse schedule resume input:', raw)
    return rejected('Invalid tool input')
  }
  if (!input.wakeTime?.trim() || !input.note?.trim()) {
    return rejected('Missing required fields: wakeTime and note are required')
  }

  // Both "at tomorrow 9am" and a bare "tomorrow 9am": the parser's 'at'
  // syntax needs the prefix.
  const trimmed = input.wakeTime.trim()
  const scheduleExpression = /^at\s/i.test(trimmed) ? trimmed : `at ${trimmed}`

  let taskId: string
  let replaced: ScheduledTask | null
  let timezone: string | undefined
  try {
    timezone = input.timezone || (await resolveTimezoneForAgent(agentSlug))
    ;({ taskId, replaced } = await createSessionWake({
      agentSlug,
      scheduleExpression,
      note: input.note,
      sessionId,
      createdByUserId: await sessionOwnerOf(agentSlug, sessionId),
      timezone,
    }))
  } catch (error) {
    console.error('[HostTools] Error handling schedule resume:', error)
    return rejected(`Failed to schedule resume: ${errorMessage(error)}`)
  }

  globalFeed.publish({ type: 'scheduled_task_created', taskId, agentSlug, resumeSessionId: sessionId })
  // The pending wake is session-level state (badges, the resume banner).
  globalFeed.publish({ type: 'session_updated', sessionId, agentSlug })

  const result = persistedResult(taskId, () => {
    const parsed = validateScheduleExpression('at', scheduleExpression, timezone)
    const resolvedTime = parsed.nextTime ? parsed.nextTime.toISOString() : scheduleExpression
    let text =
      `Scheduled this session to auto-resume at ${resolvedTime}${timezone ? ` (${timezone})` : ''} (wake ID: ${taskId}).\n\n` +
      `Your note (echoed back to you on wake): "${input.note}"`
    if (replaced) {
      text += `\n\nReplaced this session's previous pending wake (was scheduled for ${replaced.nextExecutionAt.toISOString()}). A session holds at most one pending wake.`
    }
    return (
      text +
      '\n\nEnd your turn now. This conversation will resume automatically at the scheduled time with full context; while sleeping it costs nothing and survives restarts.'
    )
  })

  return resolved(result, [
    {
      type: 'scheduled_task_created',
      toolUseId,
      taskId,
      scheduleType: 'at',
      scheduleExpression,
      agentSlug,
      resumeSessionId: sessionId,
    },
    { type: 'session_updated' },
  ])
}

/**
 * The result text for a schedule that now exists. Nothing past the write may
 * reject the agent's call: it would retry and schedule the same thing twice.
 * A text that cannot be built falls back to the id alone.
 */
function persistedResult(taskId: string, build: () => string): string {
  try {
    return build()
  } catch (error) {
    console.error('[HostTools] Schedule persisted but its result could not be formatted:', error)
    return `Scheduled (ID: ${taskId}).`
  }
}

export async function listScheduledTasks({ agentSlug }: HostToolRequest): Promise<HostToolResult> {
  try {
    const tasks = await listPendingScheduledTasks(agentSlug)
    if (tasks.length === 0) return resolved('No scheduled tasks on the schedule for this agent.')
    const lines = tasks.map((t) => {
      const kind = t.resumeSessionId
        ? `session wake (resumes session ${t.resumeSessionId})`
        : t.scheduleType === 'cron' ? 'recurring' : 'one-time'
      const next = t.nextExecutionAt ? t.nextExecutionAt.toISOString() : 'unknown'
      const status = t.status === 'paused' ? ' [PAUSED]' : ''
      return `- **${t.name || (t.resumeSessionId ? 'Session Wake' : 'Scheduled Task')}** (ID: ${t.id})${status}\n  Type: ${kind} (${t.scheduleExpression})\n  Next run: ${next}${t.timezone ? ` (${t.timezone})` : ''}\n  ${t.resumeSessionId ? 'Note' : 'Prompt'}: ${t.prompt.substring(0, 80)}${t.prompt.length > 80 ? '...' : ''}`
    })
    return resolved(`Scheduled tasks:\n\n${lines.join('\n\n')}`)
  } catch (error) {
    console.error('[HostTools] Error handling list_scheduled_tasks:', error)
    return rejected(String(error))
  }
}

/** Patch one task, so its timing and prompt change without replacing its id or history. */
export async function updateScheduledTask({ agentSlug, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    let input: ScheduledTaskUpdateInput
    try {
      input = updateScheduledTaskInputSchema.parse(JSON.parse(raw))
    } catch (error) {
      return rejected(`Invalid tool input: ${error instanceof Error ? error.message : 'Invalid tool input'}`)
    }

    const task = await getScheduledTask(input.task_id)
    if (!task || task.agentSlug !== agentSlug) return rejected(`Scheduled task ${input.task_id} not found`)

    if (input.schedule_expression !== undefined) {
      const parsed = validateScheduleExpression(task.scheduleType, input.schedule_expression, task.timezone || undefined)
      if (!parsed.valid) {
        return rejected(`Invalid ${task.scheduleType} schedule expression: ${parsed.error ?? input.schedule_expression}`)
      }
    }

    const updated = await patchScheduledTask(input.task_id, {
      ...(input.schedule_expression !== undefined ? { scheduleExpression: input.schedule_expression } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    })
    if (!updated) {
      return rejected(`Scheduled task ${input.task_id} could not be updated — only pending or paused tasks are editable`)
    }

    const refreshed = await getScheduledTask(input.task_id)
    globalFeed.publish({ type: 'scheduled_task_updated', taskId: input.task_id, agentSlug })

    const changed = [
      input.schedule_expression !== undefined ? 'schedule' : null,
      input.prompt !== undefined ? 'prompt' : null,
    ].filter(Boolean).join(' and ')
    let result = `Updated the ${changed} for scheduled task ${input.task_id}. Its ID and execution history were preserved.`
    if (refreshed && input.schedule_expression !== undefined) {
      result += `\n\nSchedule: ${refreshed.scheduleExpression}\nNext run: ${refreshed.nextExecutionAt.toISOString()}`
      const warning = getFrequencyWarning(refreshed.scheduleType, refreshed.scheduleExpression, refreshed.timezone || undefined)
      if (warning) result += `\n\n${warning}`
    }
    return resolved(result, [{ type: 'scheduled_task_updated', toolUseId, taskId: input.task_id, agentSlug }])
  } catch (error) {
    console.error('[HostTools] Error handling update_scheduled_task:', error)
    return rejected(`Failed to update scheduled task: ${errorMessage(error)}`)
  }
}

export async function cancelScheduledTaskTool({ agentSlug, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const input = parseToolInput<{ task_id: string }>(raw)
    if (input === undefined) return rejected('Invalid tool input')
    if (!input.task_id) return rejected('Missing required field: task_id')

    const task = await getScheduledTask(input.task_id)
    if (!task || task.agentSlug !== agentSlug) return rejected(`Scheduled task ${input.task_id} not found`)

    if (!(await cancelScheduledTask(input.task_id))) {
      return rejected(`Scheduled task ${input.task_id} could not be cancelled — it may have already executed or been cancelled`)
    }

    globalFeed.publish({ type: 'scheduled_task_cancelled', taskId: input.task_id, agentSlug })
    console.log(`[HostTools] Scheduled task ${input.task_id} cancelled`)
    return resolved(`Scheduled task ${input.task_id} has been cancelled. It will no longer execute.`, [
      { type: 'scheduled_task_cancelled', toolUseId, taskId: input.task_id, agentSlug },
    ])
  } catch (error) {
    console.error('[HostTools] Error handling cancel_scheduled_task:', error)
    return rejected(`Failed to cancel scheduled task: ${errorMessage(error)}`)
  }
}

export function pauseScheduledTaskTool(request: HostToolRequest): Promise<HostToolResult> {
  return pauseOrResume('pause', request)
}

export function resumeScheduledTaskTool(request: HostToolRequest): Promise<HostToolResult> {
  return pauseOrResume('resume', request)
}

async function pauseOrResume(
  action: 'pause' | 'resume',
  { agentSlug, toolUseId, input: raw }: HostToolRequest,
): Promise<HostToolResult> {
  try {
    const input = parseToolInput<{ task_id: string }>(raw)
    if (input === undefined) return rejected('Invalid tool input')
    if (!input.task_id) return rejected('Missing required field: task_id')

    const task = await getScheduledTask(input.task_id)
    if (!task || task.agentSlug !== agentSlug) return rejected(`Scheduled task ${input.task_id} not found`)

    const ok = action === 'pause' ? await pauseScheduledTask(input.task_id) : await resumeScheduledTask(input.task_id)
    if (!ok) {
      return rejected(
        action === 'pause'
          ? `Scheduled task ${input.task_id} could not be paused — only active recurring tasks can be paused`
          : `Scheduled task ${input.task_id} could not be resumed — only paused recurring tasks can be resumed`,
      )
    }

    globalFeed.publish({ type: 'scheduled_task_updated', taskId: input.task_id, agentSlug })
    const verb = action === 'pause' ? 'paused' : 'resumed'
    console.log(`[HostTools] Scheduled task ${input.task_id} ${verb}`)
    return resolved(
      `Scheduled task ${input.task_id} has been ${verb}.${action === 'pause' ? ' It will not execute until resumed.' : ' Its next run was recomputed from the schedule.'}`,
      [{ type: 'scheduled_task_updated', toolUseId, taskId: input.task_id, agentSlug }],
    )
  } catch (error) {
    console.error(`[HostTools] Error handling ${action}_scheduled_task:`, error)
    return rejected(`Failed to ${action} scheduled task: ${errorMessage(error)}`)
  }
}

/** The success message for a saved schedule, with a warning for a recurring one that runs too often. */
function formatScheduleTaskResult(input: ScheduleTaskInput, taskId: string, timezone?: string): string {
  const taskType = input.scheduleType === 'cron' ? 'recurring' : 'one-time'
  const taskName = input.name || 'Scheduled Task'
  const parsed = validateScheduleExpression(input.scheduleType, input.scheduleExpression, timezone)
  const nextRun = parsed.nextTime ? `\nNext run: ${parsed.nextTime.toISOString()}` : ''
  const continuation =
    input.scheduleType === 'cron'
      ? 'This recurring task will continue until cancelled.'
      : 'This one-time task will be removed after execution.'

  let result = `Scheduled ${taskType} task "${taskName}" (ID: ${taskId}).

Schedule: ${input.scheduleExpression}${timezone ? ` (${timezone})` : ''}${nextRun}

${continuation}`

  const warning = getFrequencyWarning(input.scheduleType, input.scheduleExpression, timezone)
  if (warning) result += `\n\n${warning}`
  return result
}

/**
 * The agent's active schedules (pending and paused): how many, a soft-cap
 * warning when that is high, and the full list, so the agent can spot a
 * duplicate or an overlap and correct itself.
 */
function formatActiveScheduleSummary(tasks: ScheduledTask[]): string {
  const count = tasks.length
  let summary = `\n\nActive schedules for this agent: ${count}`

  const warning = getScheduleCountWarning(count)
  if (warning) summary += `\n\n${warning}`

  if (count > 0) {
    const list = tasks
      .map((t) => {
        const kind = t.resumeSessionId ? 'session wake' : t.scheduleType === 'cron' ? 'recurring' : 'one-time'
        const next = t.nextExecutionAt ? t.nextExecutionAt.toISOString() : 'unknown'
        const status = t.status === 'paused' ? ' [PAUSED]' : ''
        return `- **${t.name || (t.resumeSessionId ? 'Session Wake' : 'Scheduled Task')}** (ID: ${t.id})${status} — ${kind} (${t.scheduleExpression}), next run ${next}${t.timezone ? ` (${t.timezone})` : ''}`
      })
      .join('\n')
    summary += `\n\n${list}`
  }
  return summary
}
