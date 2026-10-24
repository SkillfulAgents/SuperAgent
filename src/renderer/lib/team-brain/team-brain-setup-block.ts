import { TEAM_BRAIN_SCHEDULES, type TeamBrainSchedule } from './team-brain-schema'

/** The upkeep task's cron for each schedule. */
export const TEAM_BRAIN_CRON: Record<TeamBrainSchedule, string> = {
  hourly: '0 * * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 1',
}

/** The upkeep task the onboarding skill schedules, by its name, however the agent cased or spaced it. */
export const isBrainUpkeep = (name: string | null) => name?.trim().replace(/\s+/g, ' ').toLowerCase() === 'brain upkeep'

/** Which schedule a cron is, if it is one of them. */
export const scheduleOfCron = (cron: string) => TEAM_BRAIN_SCHEDULES.find((s) => TEAM_BRAIN_CRON[s] === cron) ?? null

/** Each schedule as the agent's onboarding skill reads it from the setup block. */
const SCHEDULE_TEXT: Record<TeamBrainSchedule, string> = {
  hourly: `hourly, on the hour (cron \`${TEAM_BRAIN_CRON.hourly}\`)`,
  daily: `daily at midnight (cron \`${TEAM_BRAIN_CRON.daily}\`)`,
  weekly: `weekly, Mondays at midnight (cron \`${TEAM_BRAIN_CRON.weekly}\`)`,
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
