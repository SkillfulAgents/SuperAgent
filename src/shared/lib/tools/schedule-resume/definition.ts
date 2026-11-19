import { scheduleResumeInputSchema, type ScheduleResumeInput } from './schema'

function parseInput(input: unknown): ScheduleResumeInput {
  return scheduleResumeInputSchema.safeParse(input).data ?? {}
}

function getSummary(input: unknown): string | null {
  const { wakeTime, summary, note, timezone } = parseInput(input)
  const time = wakeTime?.replace(/^at\s+/i, '')
  const tzSuffix = timezone ? ` (${timezone.replace(/_/g, ' ')})` : ''
  const text = summary || note

  if (time && text) return `${time}${tzSuffix} · ${text}`
  if (time) return `${time}${tzSuffix}`
  if (text) return text
  return null
}

export const scheduleResumeDef = {
  showWaitingForInput: true,
  displayName: 'Schedule Resume',
  parseInput,
  getSummary,
} as const
