// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { RecallSetupForm } from './recall-setup-form'

const state = vi.hoisted(() => ({ create: vi.fn(), navigate: vi.fn(), agentName: 'Assistant' as string | undefined }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: state.agentName ? { name: state.agentName } : undefined }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useCreateAgentIntegration: () => ({ mutateAsync: state.create, isPending: false }),
}))

beforeEach(() => { vi.clearAllMocks(); state.agentName = 'Assistant'; state.create.mockResolvedValue({ id: 'int-1' }) })
afterEach(cleanup)
function renderSetup(onIntegrationCreated?: (id: string) => void) {
  return render(<Dialog open><DialogContent><RecallSetupForm agentSlug="agent" onClose={vi.fn()} onIntegrationCreated={onIntegrationCreated} /></DialogContent></Dialog>)
}

it('starts with the agent\'s name in calls and connects with it when left alone', async () => {
  renderSetup()
  expect(screen.getByLabelText(/name in calls/i)).toHaveValue('Assistant')
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(state.create).toHaveBeenCalledWith({ agentSlug: 'agent', provider: 'recall', name: 'Assistant', config: { botName: 'Assistant' } })
  expect(state.navigate).toHaveBeenCalledWith({ to: '/agents/$slug/chat/$integrationId', params: { slug: 'agent', integrationId: 'int-1' } })
})

it('returns the meetings connection to the wizard and keeps it on the add-ons step', async () => {
  const complete = vi.fn()
  renderSetup(complete)
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(complete).toHaveBeenCalledWith('int-1')
  expect(state.navigate).not.toHaveBeenCalled()
})

it('sends an edited name and the standing instructions with the installation', async () => {
  renderSetup()
  const name = screen.getByLabelText(/name in calls/i)
  await userEvent.clear(name)
  await userEvent.type(name, 'Notes Bot')
  await userEvent.type(screen.getByLabelText(/instructions for every meeting/i), 'Track action items with owners.')
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(state.create).toHaveBeenCalledWith({ agentSlug: 'agent', provider: 'recall', name: 'Notes Bot', config: { botName: 'Notes Bot', instructions: 'Track action items with owners.' } })
})

it('connects without a stored name when the field is emptied, leaving the agent\'s name to apply at join time', async () => {
  renderSetup()
  await userEvent.clear(screen.getByLabelText(/name in calls/i))
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(state.create).toHaveBeenCalledWith({ agentSlug: 'agent', provider: 'recall', name: 'Assistant', config: {} })
})
