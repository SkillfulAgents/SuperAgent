import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

/**
 * Build the system message delivered when a session wake fires. The [SYSTEM]
 * prefix renders it as a system message and keeps it from counting as a human
 * message (so it never promotes an automated session to the interactive
 * eviction class). The agent's own note is echoed back verbatim.
 *
 * Shared by the scheduler's wake branch and the run-now ("Wake now") route so
 * both deliver the same shape.
 */
export function buildWakeMessage(
  task: ScheduledTask,
  trigger: 'scheduled' | 'manual' = 'scheduled'
): string {
  const scheduledFor = `${task.nextExecutionAt.toISOString()}${task.timezone ? ` (${task.timezone})` : ''}`
  const intro =
    trigger === 'manual'
      ? `This session is resuming now — the user chose to wake it early (it was scheduled to resume at ${scheduledFor}).`
      : `This session is resuming as scheduled. You asked (on ${task.createdAt.toISOString()}) to be woken at ${scheduledFor}.`
  return `[SYSTEM] ${intro}\nYour note: ${task.prompt}`
}
