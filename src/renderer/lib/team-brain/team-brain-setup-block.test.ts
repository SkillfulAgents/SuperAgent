import { describe, expect, it } from 'vitest'
import { fillTeamBrainSetupBlock, isBrainUpkeep } from './team-brain-setup-block'

const BLOCK = [
  '- **Brain location:** `{{brain_path}}`',
  '- **Your slug:** `{{agent_slug}}`.',
  '- **Owner:** `{{owner}}`.',
  '- **Already connected:** `{{connected_accounts}}`.',
  '- **Maintenance schedule:** `{{schedule}}`',
].join('\n')

describe('fillTeamBrainSetupBlock', () => {
  it('fills the location, its slug and the schedule cron the onboarding skill schedules from, and leaves the rest for the agent', () => {
    expect(fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'weekly', owner: null, accounts: undefined })).toBe([
      '- **Brain location:** `/mounts/Team Brain`',
      '- **Your slug:** `team-brain`.',
      '- **Owner:** `{{owner}}`.',
      '- **Already connected:** `{{connected_accounts}}`.',
      '- **Maintenance schedule:** weekly, Mondays at midnight (cron `0 0 * * 1`)',
    ].join('\n'))
  })

  it('puts a drive or owner name with dollar signs in as written', () => {
    const filled = fillTeamBrainSetupBlock('`{{brain_path}}` `{{owner}}`', {
      agentSlug: 'b', brainPath: "/mounts/Costs $& $' Q4", schedule: 'daily', owner: { name: 'A $& B', email: 'a@b.co' }, accounts: undefined,
    })
    expect(filled).toBe("`/mounts/Costs $& $' Q4` `A $& B (a@b.co)`")
  })

  it('fills the owner with the signed-in name and email the opening research starts from', () => {
    const fill = (owner: { name: string; email: string }) =>
      fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'daily', owner, accounts: undefined })
    expect(fill({ name: 'Ada Lovelace', email: 'ada@acme.com' })).toContain('- **Owner:** `Ada Lovelace (ada@acme.com)`.')
    expect(fill({ name: ' ', email: 'ada@acme.com' })).toContain('- **Owner:** `ada@acme.com`.')
  })

  it('lists each active account type once, by the toolkit slug the connect prompt takes', () => {
    const fill = (accounts: { toolkitSlug: string; status: string }[]) =>
      fillTeamBrainSetupBlock(BLOCK, { agentSlug: 'team-brain', brainPath: '/mounts/Team Brain', schedule: 'daily', owner: null, accounts })
    expect(fill([
      { toolkitSlug: 'slack', status: 'active' }, { toolkitSlug: 'github', status: 'active' },
      { toolkitSlug: 'slack', status: 'active' }, { toolkitSlug: 'notion', status: 'expired' },
    ])).toContain('- **Already connected:** `github, slack`.')
    expect(fill([])).toContain('- **Already connected:** `none`.')
  })
})

describe('isBrainUpkeep', () => {
  it('finds the upkeep task however the agent cased or spaced its name', () => {
    expect(['Brain upkeep', 'Brain Upkeep', ' brain  upkeep '].every(isBrainUpkeep)).toBe(true)
    expect(isBrainUpkeep('Brain upkeep (weekly)')).toBe(false)
  })
})
