// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { AgentAddonsStep } from './agent-addons-step'

const dream = { name: 'dream', path: 'skills/dream/SKILL.md', version: '0.1.0', skillsetId: DEFAULT_PUBLIC_SKILLSET.id }

const state = { integrations: [] as Partial<PublicAgentIntegration>[], skills: [dream] as typeof dream[] | undefined, catalogError: false, brain: true, everyAgent: false }
let availableProviders: string[] | undefined
const install = vi.fn()
const toggle = vi.fn()
const refetchCatalog = vi.fn()
vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: state.brain ? [{ slug: 'brain', teamBrain: { volumeId: 'drive' } }] : [] }) }))
vi.mock('@renderer/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ data: [], refetch: vi.fn() }),
  useDiscoverableSkills: () => ({ data: state.skills, isError: state.catalogError, refetch: refetchCatalog }),
  useInstallSkill: () => ({ mutateAsync: install }),
  useDeleteSkill: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => ({ data: {} }),
  useUpdateAgentPreferences: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-team-brain-access', () => ({
  useTeamBrainAccess: () => ({ isOn: () => false, isChanging: () => false, ready: true, everyAgent: state.everyAgent, toggle }),
}))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useAgentIntegrations: () => ({ data: state.integrations }),
  useAvailableAgentIntegrationProviders: () => ({ data: availableProviders?.map(provider => ({ provider })) }),
}))
vi.mock('@renderer/components/agent-integrations/agent-integration-setup-dialog', () => ({
  AgentIntegrationSetupDialog: ({ provider }: { provider: { slug: string } | null }) => provider && <div role="dialog">{provider.slug}</div>,
}))
const show = () => render(<AgentAddonsStep header={null} agentSlug="scout" onBusyChange={vi.fn()} onDreamChange={vi.fn()} />)
beforeEach(() => {
  vi.clearAllMocks()
  availableProviders = ['platform-email', 'slack', 'telegram', 'imessage']
  state.integrations = []
  state.skills = [dream]
  state.catalogError = false
  state.brain = true
  state.everyAgent = false
})
it('installs the public Dream skill and grants Team Brain to the confirmed agent', async () => {
  show()
  await userEvent.click(screen.getByRole('switch', { name: 'Self-Improvement' }))
  expect(install).toHaveBeenCalledWith({ agentSlug: 'scout', skillsetId: dream.skillsetId, skillPath: dream.path, skillVersion: dream.version, skillName: dream.name })
  await userEvent.click(screen.getByRole('switch', { name: 'Team Brain' }))
  expect(toggle).toHaveBeenCalledWith('scout', true)
})
it('waits for the catalog before claiming Dream is missing and lets a failed read retry', async () => {
  state.skills = undefined
  const view = show()
  expect(screen.getByRole('switch', { name: 'Self-Improvement' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Why Self-Improvement is unavailable' })).toBeNull()
  state.catalogError = true
  view.rerender(<AgentAddonsStep header={null} agentSlug="scout" onBusyChange={vi.fn()} onDreamChange={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Retry loading skills' }))
  expect(refetchCatalog).toHaveBeenCalled()
})

it('explains unavailable add-ons, including a same-named skill from another set', async () => {
  state.skills = [{ ...dream, skillsetId: 'different-set' }]
  state.brain = false
  show()
  const skill = screen.getByRole('switch', { name: 'Self-Improvement' })
  const brain = screen.getByRole('switch', { name: 'Team Brain' })
  expect(skill).toBeDisabled()
  expect(brain).toBeDisabled()
  const user = userEvent.setup()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Why Self-Improvement is unavailable' })).toHaveFocus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Gamut Public Skillset')
  await user.tab()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Why Team Brain is unavailable' })).toHaveFocus()
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Set up Team Brain'))
  await user.click(screen.getByText('Self-Improvement'))
  expect(install).not.toHaveBeenCalled()
  expect(screen.queryByText('Proactivity')).toBeNull()
})
it('shows Team Brain as locked on when the workspace enables it for every agent', async () => {
  state.everyAgent = true
  show()
  const brain = screen.getByRole('switch', { name: 'Team Brain' })
  expect(brain).toBeChecked()
  expect(brain).toBeDisabled()
  expect(screen.getByText('On')).toBeVisible()
  const user = userEvent.setup()
  const explanation = screen.getByRole('button', { name: 'Why Team Brain is on' })
  await user.hover(explanation)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Team Brain is enabled by default for all agents in this workspace.')
  await user.click(explanation)
  await user.keyboard(' ')
  expect(brain).toBeChecked()
  expect(toggle).not.toHaveBeenCalled()
})
it.each([['Inbox', 'platform-email'], ['Slack', 'slack']])('opens the existing %s setup', async (label, provider) => {
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Set up ' + label }))
  expect(screen.getByRole('dialog')).toHaveTextContent(provider)
})

it.each([['Telegram', 'telegram'], ['iMessage', 'imessage']])('opens %s setup from More channels', async (label, provider) => {
  show()
  const action = { name: 'Set up ' + label }
  expect(screen.queryByRole('button', action)).toBeNull()
  const more = screen.getByRole('button', { name: 'More channels' })
  await userEvent.click(more)
  expect(more).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', action)).toBeVisible()
  await userEvent.click(more)
  expect(screen.queryByRole('button', action)).toBeNull()
  await userEvent.click(more)
  await userEvent.click(screen.getByRole('button', action))
  expect(screen.getByRole('dialog')).toHaveTextContent(provider)
})

it.each([
  { providers: undefined, reason: 'Checking available channels' },
  { providers: ['slack'], reason: 'Connect your Gamut account to set up Inbox.' },
])('explains a disabled Inbox action on focus and tap', async ({ providers, reason }) => {
  availableProviders = providers
  show()
  const inbox = screen.getByRole('button', { name: 'Set up Inbox' })
  expect(inbox).toHaveAttribute('aria-disabled', 'true')
  const user = userEvent.setup()
  await user.click(screen.getByRole('switch', { name: 'Team Brain' }))
  await user.tab()
  expect(inbox).toHaveFocus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('tooltip')).toBeNull()
  await user.click(inbox)
  expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('explains both configured and unavailable channels inside More', async () => {
  availableProviders = ['telegram']
  state.integrations = [{ provider: 'telegram' }]
  show()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'More channels' }))
  const telegram = screen.getByRole('button', { name: 'Configured Telegram' })
  await user.hover(telegram)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Telegram is already set up')
  await user.unhover(telegram)
  await user.click(screen.getByRole('button', { name: 'Set up iMessage' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('iMessage is unavailable in this workspace.')
  expect(screen.queryByRole('dialog')).toBeNull()
})

vi.mock('@renderer/components/agent-integrations/provisioned-app-card', () => ({
  ProvisionedAppCard: ({ integration }: { integration: PublicAgentIntegration }) => <button>Install {integration.id}</button>,
}))
vi.mock('@renderer/components/agent-integrations/slack-setup', () => ({
  SlackSetup: () => null,
  SlackConnectionSettings: ({ integration }: { integration: PublicAgentIntegration }) => <button>Connect {integration.id}</button>,
}))

it.each([
  { provisionedApp: { installed: false }, action: 'Install' },
  { slack: { botTokenSaved: false, webhook: { status: 'pending' } }, action: 'Connect' },
])('resumes the existing incomplete Slack connection', async ({ action, ...fields }) => {
  state.integrations = [{ id: 'existing', provider: 'slack', ...fields } as Partial<PublicAgentIntegration>]
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Finish setup Slack' }))
  expect(screen.getByRole('dialog')).toHaveTextContent(action + ' existing')
})
