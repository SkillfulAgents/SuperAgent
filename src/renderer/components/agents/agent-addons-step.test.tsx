// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import { AgentAddonsStep } from './agent-addons-step'

const dream = { name: 'dream', path: 'skills/dream/SKILL.md', version: '0.1.0', skillsetId: DEFAULT_PUBLIC_SKILLSET.id }
const state = { skills: [dream], brain: true }
const install = vi.fn()
const toggle = vi.fn()
vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: state.brain ? [{ slug: 'brain', teamBrain: { volumeId: 'drive' } }] : [] }) }))
vi.mock('@renderer/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ data: [], refetch: vi.fn() }),
  useDiscoverableSkills: () => ({ data: state.skills, refetch: vi.fn() }),
  useInstallSkill: () => ({ mutateAsync: install }),
  useDeleteSkill: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => ({ data: {} }),
  useUpdateAgentPreferences: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-team-brain-access', () => ({
  useTeamBrainAccess: () => ({ isOn: () => false, isChanging: () => false, ready: true, everyAgent: false, toggle }),
}))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useAgentIntegrations: () => ({ data: [] }),
  useAvailableAgentIntegrationProviders: () => ({ data: [{ provider: 'slack' }, { provider: 'platform-email' }] }),
}))
vi.mock('@renderer/components/agent-integrations/agent-integration-setup-dialog', () => ({
  AgentIntegrationSetupDialog: ({ provider }: { provider: { slug: string } | null }) => provider && <div role="dialog">{provider.slug}</div>,
}))
const show = () => render(<AgentAddonsStep header={null} agentSlug="scout" onBusyChange={vi.fn()} />)
beforeEach(() => {
  vi.clearAllMocks()
  state.skills = [dream]
  state.brain = true
})
it('installs the public Dream skill and grants Team Brain to the confirmed agent', async () => {
  show()
  await userEvent.click(screen.getByRole('switch', { name: 'Self-Improvement' }))
  expect(install).toHaveBeenCalledWith({ agentSlug: 'scout', skillsetId: dream.skillsetId, skillPath: dream.path, skillVersion: dream.version, skillName: dream.name })
  await userEvent.click(screen.getByRole('switch', { name: 'Team Brain' }))
  expect(toggle).toHaveBeenCalledWith('scout', true)
})
it('explains unavailable add-ons, including a same-named skill from another set', async () => {
  state.skills = [{ ...dream, skillsetId: 'different-set' }]
  state.brain = false
  show()
  const skill = screen.getByRole('switch', { name: 'Self-Improvement' })
  const brain = screen.getByRole('switch', { name: 'Team Brain' })
  expect(skill).toHaveAttribute('aria-disabled', 'true')
  expect(brain).toHaveAttribute('aria-disabled', 'true')
  const user = userEvent.setup()
  await user.tab()
  expect(skill).toHaveFocus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Gamut Public Skillset')
  await user.tab()
  await user.tab()
  expect(brain).toHaveFocus()
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Set up Team Brain'))
  await userEvent.click(skill)
  expect(install).not.toHaveBeenCalled()
  expect(screen.queryByText('Proactivity')).toBeNull()
})
it.each([['Inbox', 'platform-email'], ['Slack', 'slack']])('opens the existing %s setup', async (label, provider) => {
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Set up ' + label }))
  expect(screen.getByRole('dialog')).toHaveTextContent(provider)
})
