export interface ScheduleTaskInput {
  scheduleType?: 'at' | 'cron'
  scheduleExpression?: string
  prompt?: string
  name?: string
  timezone?: string
}

function parseInput(input: unknown): ScheduleTaskInput {
  return typeof input === 'object' && input !== null ? (input as ScheduleTaskInput) : {}
}

export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  if (cron === '* * * * *') return 'Every minute'
  if (cron === '0 * * * *') return 'Every hour'
  if (cron === '0 0 * * *') return 'Daily at midnight'
  if (cron === '0 0 * * 0') return 'Weekly on Sunday'
  if (cron === '0 0 1 * *') return 'Monthly on the 1st'

  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${minute.slice(2)} minutes`
  }
  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${hour.slice(2)} hours`
  }

  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dayOfMonth === '*' && month === '*') {
    const h = parseInt(hour, 10)
    const m = parseInt(minute, 10)
    const time = `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
    if (dayOfWeek === '*') return `Daily at ${time}`
    if (dayOfWeek === '1-5') return `Weekdays at ${time}`
    if (dayOfWeek === '0,6') return `Weekends at ${time}`
  }

  return cron
}

function getSummary(input: unknown): string | null {
  const { name, scheduleType, scheduleExpression, timezone } = parseInput(input)
  const prefix = scheduleType === 'cron' ? '🔁' : '📅'

  let schedule = ''
  if (scheduleType === 'cron' && scheduleExpression) {
    schedule = cronToHuman(scheduleExpression)
  } else if (scheduleExpression) {
    schedule = scheduleExpression.replace(/^at\s+/i, '')
  }

  const tzSuffix = timezone ? ` (${timezone.replace(/_/g, ' ')})` : ''

  if (name && schedule) return `${prefix} ${name} · ${schedule}${tzSuffix}`
  if (name) return `${prefix} ${name}${tzSuffix}`
  if (schedule) return `${prefix} ${schedule}${tzSuffix}`
  return null
}

export const scheduleTaskDef = { displayName: 'Schedule Task', iconName: 'Clock', parseInput, getSummary } as const
