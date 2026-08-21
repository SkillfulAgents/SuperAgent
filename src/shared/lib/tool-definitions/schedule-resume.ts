export interface ScheduleResumeInput {
  wakeTime?: string
  note?: string
  timezone?: string
}

function parseInput(input: unknown): ScheduleResumeInput {
  return typeof input === 'object' && input !== null ? (input as ScheduleResumeInput) : {}
}

function getSummary(input: unknown): string | null {
  const { wakeTime, note, timezone } = parseInput(input)
  const time = wakeTime?.replace(/^at\s+/i, '')
  const tzSuffix = timezone ? ` (${timezone.replace(/_/g, ' ')})` : ''

  if (time && note) return `${time}${tzSuffix} · ${note}`
  if (time) return `${time}${tzSuffix}`
  if (note) return note
  return null
}

export const scheduleResumeDef = { displayName: 'Schedule Resume', parseInput, getSummary } as const
