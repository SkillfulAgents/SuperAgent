// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { EmailIntegrationSetupForm } from './email-integration-setup-form'

const state = vi.hoisted(() => ({
  setupError: null as Error | null,
  emailDomain: undefined as string | undefined,
  create: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Assistant' } }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { connected: true } }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, user: { email: 'owner@example.com' } }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useAgentIntegrationSetup: () => ({
    error: state.setupError,
    data: state.emailDomain ? { emailDomain: state.emailDomain, agentUserEmails: ['owner@example.com'] } : undefined,
    isPending: false,
  }),
  useCreateAgentIntegration: () => ({ mutateAsync: state.create, isPending: false }),
}))

beforeEach(() => { vi.clearAllMocks(); state.setupError = null; state.emailDomain = undefined })
afterEach(cleanup)
function renderSetup() {
  return render(<Dialog open><DialogContent><EmailIntegrationSetupForm agentSlug="agent" onClose={vi.fn()} /></DialogContent></Dialog>)
}

it('shows the discovery failure before creating an inbox', () => {
  state.setupError = new Error('Platform deployment discovery unavailable')
  renderSetup()
  expect(screen.getByRole('alert')).toHaveTextContent(state.setupError.message)
  expect(state.create).not.toHaveBeenCalled()
})

it('shows the address preview without an error after discovery succeeds', () => {
  state.emailDomain = 'company.ongamut.so'
  renderSetup()
  expect(screen.getByText('assistant@company.ongamut.so')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(state.create).not.toHaveBeenCalled()
})
