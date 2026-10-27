import { describe, expect, it } from 'vitest'
import { fillTeamBrainSetupBlock } from './team-brain-setup-block'

const BLOCK = [
  '- **Brain location:** `{{brain_path}}`',
  '- **Your slug:** `{{agent_slug}}`.',
  '- **Set up by:** `{{set_up_by}}`.',
  '- **Already connected:** `{{connected_accounts}}`.',
  '- **Maintenance schedule:** `{{schedule}}`',
].join('\n')

describe('fillTeamBrainSetupBlock', () => {
  it('fills the location, its slug and the schedule cron the onboarding skill schedules from, and leaves the rest for the agent', () => {
    expect(fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'weekly', setUpBy: null, accounts: undefined })).toBe([
      '- **Brain location:** `/mounts/Team Brain`',
      '- **Your slug:** `team-brain`.',
      '- **Set up by:** `{{set_up_by}}`.',
      '- **Already connected:** `{{connected_accounts}}`.',
      '- **Maintenance schedule:** weekly, Mondays at midnight (cron `0 0 * * 1`)',
    ].join('\n'))
  })

  it('puts a drive name, or the name of who set it up, with dollar signs in as written', () => {
    const filled = fillTeamBrainSetupBlock('`{{brain_path}}` `{{set_up_by}}`', {
      agentSlug: 'b', brainPath: "/mounts/Costs $& $' Q4", schedule: 'daily', setUpBy: { name: 'A $& B', email: 'a@b.co' }, accounts: undefined,
    })
    expect(filled).toBe("`/mounts/Costs $& $' Q4` `A $& B (a@b.co)`")
  })

  it('fills who set it up with the signed-in name and email the opening research starts from', () => {
    const fill = (setUpBy: { name: string; email: string }) =>
      fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'daily', setUpBy, accounts: undefined })
    expect(fill({ name: 'Ada Lovelace', email: 'ada@acme.com' })).toContain('- **Set up by:** `Ada Lovelace (ada@acme.com)`.')
    expect(fill({ name: ' ', email: 'ada@acme.com' })).toContain('- **Set up by:** `ada@acme.com`.')
  })

  it('lists each active account type once, by the toolkit slug the connect prompt takes', () => {
    const fill = (accounts: { toolkitSlug: string; status: string }[]) =>
      fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'daily', setUpBy: null, accounts })
    expect(fill([
      { toolkitSlug: 'slack', status: 'active' }, { toolkitSlug: 'github', status: 'active' },
      { toolkitSlug: 'slack', status: 'active' }, { toolkitSlug: 'notion', status: 'expired' },
    ])).toContain('- **Already connected:** `github, slack`.')
    expect(fill([])).toContain('- **Already connected:** `none`.')
  })
})
