import type { TeamBrainSchedule } from './team-brain-schema'

/** Each sync schedule's name, and the trade-off it makes between fresh context and cost. */
export const SCHEDULE_LABELS: Record<TeamBrainSchedule, { title: string; detail: string }> = {
  hourly: { title: 'Every hour', detail: 'Freshest. Up to 24 syncs a day, so it costs the most.' },
  daily: { title: 'Daily', detail: 'Overnight, ready by morning. One sync a day keeps costs low.' },
  weekly: { title: 'Weekly', detail: 'Cheapest. Agents can be up to a week behind.' },
}
