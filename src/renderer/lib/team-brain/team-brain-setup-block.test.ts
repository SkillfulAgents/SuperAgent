import { describe, expect, it } from 'vitest'
import { fillTeamBrainSetupBlock } from './team-brain-setup-block'

const BLOCK = [
  '- **Brain location:** `{{brain_path}}`',
  '- **Your slug:** `{{agent_slug}}`.',
  '- **Owner:** `{{owner}}`.',
  '- **Maintenance schedule:** `{{schedule}}`',
].join('\n')

describe('fillTeamBrainSetupBlock', () => {
  it('fills the location, its slug and the schedule cron the onboarding skill schedules from, and leaves the rest for the agent', () => {
    expect(fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'weekly' })).toBe([
      '- **Brain location:** `/mounts/Team Brain`',
      '- **Your slug:** `team-brain`.',
      '- **Owner:** `{{owner}}`.',
      '- **Maintenance schedule:** weekly, Mondays at midnight (cron `0 0 * * 1`)',
    ].join('\n'))
  })

  it('puts a drive name with dollar signs in as written', () => {
    expect(fillTeamBrainSetupBlock('`{{brain_path}}`', { agentSlug: 'b', brainPath: "/mounts/Costs $& $' Q4", schedule: 'daily' })).toBe("`/mounts/Costs $& $' Q4`")
  })
})
