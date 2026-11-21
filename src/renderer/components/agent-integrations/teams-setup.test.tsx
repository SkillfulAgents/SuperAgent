// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { TeamsConnectionSettings, TeamsSetup } from './teams-setup'
import { makeChatIntegration } from './test-factories'

const APP_ID = 'aea78f5e-77a2-4b06-9694-dfaeda7d2dcd'
const TENANT_ID = '3b984d1f-9e6d-4c6e-a0cc-35b28d001999'
const ENDPOINT = 'https://gateway.test/hooks/teams-demo'
const agent = { name: 'Design Agent', slug: 'design', avatar: undefined, description: 'Design reviews' }
const state = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), navigate: vi.fn(), pack: vi.fn(), save: vi.fn(), base: '' }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: agent }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useCreateAgentIntegration: () => ({ mutateAsync: state.create }),
  useUpdateAgentIntegration: () => ({ mutateAsync: state.update, reset: () => {} }),
  useAgentIntegrationSetup: () => ({ data: { teamsMessagingBaseUrl: state.base, teamsRelayAvailable: !state.base } }),
}))
vi.mock('./teams-app-package', () => ({ teamsAppPackage: state.pack }))
vi.mock('@renderer/lib/download', () => ({ saveBlob: state.save }))

const row = () => makeChatIntegration({ id: 'i1', provider: 'teams', name: 'Design Agent', teams: { appId: APP_ID, tenantId: TENANT_ID, deliveryMode: 'https', messagingEndpoint: ENDPOINT } })
function wizard(onIntegrationCreated?: (id: string) => void) {
  return render(<Dialog open><DialogContent><TeamsSetup agentSlug="design" onClose={vi.fn()} onIntegrationCreated={onIntegrationCreated} /></DialogContent></Dialog>)
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
function credentials() {
  fill('Application (client) ID', APP_ID)
  fill('Directory (tenant) ID', TENANT_ID)
  fill('Client secret value', 'secret-value')
}

beforeEach(() => {
  vi.clearAllMocks()
  state.base = ''
  state.create.mockResolvedValue(row())
  state.pack.mockResolvedValue(new Blob(['zip']))
})
afterEach(cleanup)

it('downloads a per-agent package before saving and guides a directory-free installation through a relay', async () => {
  const done = vi.fn()
  wizard(done)
  expect(screen.queryByRole('button', { name: 'Download app package' })).toBeNull()
  expect(screen.getByLabelText('App name in Teams')).toHaveValue(agent.name)
  credentials()
  expect(screen.getByText(/generate this bot’s public messaging endpoint/i)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Download app package' }))
  await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.any(Blob), 'design-teams.zip'))
  expect(state.pack).toHaveBeenCalledWith(agent, APP_ID, agent.name, '1.0.0')
  expect(state.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
  await screen.findByText('Credentials saved for Design Agent.')
  expect(state.create).toHaveBeenCalledWith({ provider: 'teams', agentSlug: 'design', name: agent.name, config: {
    appId: APP_ID, tenantId: TENANT_ID, clientSecret: 'secret-value', deliveryMode: 'https',
  } })
  expect(screen.getByTestId('teams-messaging-endpoint')).toHaveTextContent(ENDPOINT)
  expect(screen.getByRole('link', { name: 'Teams admin center' })).toBeVisible()
  expect(screen.queryByDisplayValue('secret-value')).toBeNull()
  expect(done).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(done).toHaveBeenCalledWith('i1')
})

it('shows a public HTTPS URL before saving, and switches to native socket setup without one', async () => {
  state.base = 'https://gamut.example/api/teams/messages'
  wizard()
  credentials()
  expect(screen.getByTestId('teams-messaging-endpoint')).toHaveTextContent(state.base + '/' + APP_ID)
  const saved = row()
  state.create.mockResolvedValue({ ...saved, teams: { ...saved.teams, deliveryMode: 'socket', messagingEndpoint: undefined } })
  fireEvent.click(screen.getByRole('radio', { name: /Socket mode/ }))
  expect(screen.queryByTestId('teams-messaging-endpoint')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
  await screen.findByRole('button', { name: 'Done' })
  expect(state.create.mock.calls[0][0].config.deliveryMode).toBe('socket')
  expect(screen.queryByTestId('teams-messaging-endpoint')).toBeNull()
  expect(screen.getByText('Socket mode', { selector: 'strong' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(state.navigate).toHaveBeenCalledWith({ to: '/agents/$slug/chat/$integrationId', params: { slug: 'design', integrationId: 'i1' } })
})

it('keeps invalid or rejected credentials editable', async () => {
  wizard()
  credentials()
  fill('Directory (tenant) ID', 'not-an-id')
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('UUIDs')
  expect(state.create).not.toHaveBeenCalled()
  fill('Directory (tenant) ID', TENANT_ID)
  state.create.mockRejectedValueOnce(new Error('Could not verify the client secret'))
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not verify the client secret')
  expect(screen.getByLabelText('Client secret value')).toHaveValue('secret-value')
})

it('can resume installation, update a ZIP version and rotate a secret from connection settings', async () => {
  render(<TeamsConnectionSettings integration={row()} />)
  expect(screen.getByTestId('teams-messaging-endpoint')).toHaveTextContent(ENDPOINT)
  fill('Package version', '1.2.0')
  fireEvent.click(screen.getByRole('button', { name: 'Download app package' }))
  await waitFor(() => expect(state.pack).toHaveBeenCalledWith(agent, APP_ID, agent.name, '1.2.0'))
  fireEvent.click(screen.getByText('Replace client secret'))
  fill('New client secret value', 'new-value')
  fireEvent.click(screen.getByRole('button', { name: 'Save new secret' }))
  await waitFor(() => expect(screen.getByLabelText('New client secret value')).toHaveValue(''))
  expect(state.update).toHaveBeenCalledWith({ id: 'i1', config: { clientSecret: 'new-value' } })
})
