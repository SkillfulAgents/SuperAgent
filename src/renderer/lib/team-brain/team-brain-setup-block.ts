import type { TeamBrainSchedule } from './team-brain-schema'

/** The upkeep task's cron for each schedule, read by the agent's onboarding skill from the setup block. */
const SCHEDULE_TEXT: Record<TeamBrainSchedule, string> = {
  hourly: 'hourly, on the hour (cron `0 * * * *`)',
  daily: 'daily at midnight (cron `0 0 * * *`)',
  weekly: 'weekly, Mondays at midnight (cron `0 0 * * 1`)',
}

/** Fill the Team Brain template's setup block; placeholders the modal does not settle stay for the agent. */
export function fillTeamBrainSetupBlock(
  instructions: string,
  { agentSlug, brainPath, schedule }: { agentSlug: string; brainPath: string; schedule: TeamBrainSchedule },
): string {
  return instructions
    .replace('`{{brain_path}}`', `\`${brainPath}\``)
    .replace('`{{agent_slug}}`', `\`${agentSlug}\``)
    .replace('`{{schedule}}`', SCHEDULE_TEXT[schedule])
}
