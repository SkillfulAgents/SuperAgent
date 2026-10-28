// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EmailAccessFields } from './email-access-fields'
const state = vi.hoisted(() => ({ members: ['owner@example.com'] as string[] | undefined, auth: false, pending: false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: state.auth, user: { email: 'member@example.com' } }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { email: 'owner@example.com' } }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({ useAgentIntegrationSetup: () => ({ data: { agentUserEmails: state.members }, isPending: state.pending }) }))
const props = { agentSlug: 'agent', onChange: vi.fn(), domains: '', onDomainsChange: vi.fn() }
afterEach(cleanup)
beforeEach(() => { state.members = ['owner@example.com']; state.auth = false; state.pending = false })
it('names the connected account and limits outside replies to the same thread', () => {
  render(<EmailAccessFields {...props} value="agent-users-and-replies" />)
  expect(screen.getByText('You (owner@example.com)')).toBeInTheDocument()
  expect(screen.getByText('People it has reached out to, when they reply in the same email thread.')).toBeInTheDocument()
  expect(screen.getByText('It can send emails to anyone.')).toBeInTheDocument()
})
it('labels the signed-in member as You in auth mode and lists other permitted addresses', () => {
  state.auth = true; state.members = ['owner@example.com', 'member@example.com']
  render(<EmailAccessFields {...props} value="agent-users" />)
  expect(screen.getByText('You (member@example.com)')).toBeInTheDocument()
  expect(screen.getByText('owner@example.com')).toBeInTheDocument()
  expect(screen.queryByText(/People it has reached out to/)).not.toBeInTheDocument()
})
it('shows empty membership explicitly without inventing a connected-account allowance', () => {
  state.members = []
  render(<EmailAccessFields {...props} value="agent-users" />)
  expect(screen.getByText('No agent users currently have a permitted email address.')).toBeInTheDocument()
  expect(screen.queryByText(/You \(/)).not.toBeInTheDocument()
})
it('does not confuse an unavailable list with an empty list', () => {
  state.members = undefined
  render(<EmailAccessFields {...props} value="agent-users" />)
  expect(screen.getByText('Could not load permitted email addresses.')).toBeInTheDocument()
  expect(screen.queryByText(/No agent users currently/)).not.toBeInTheDocument()
})
it('updates the domain summary and replaces it when access becomes public', () => {
  const { rerender } = render(<EmailAccessFields {...props} value="allowed-domains" domains="Company.com, team.company.com, company.com" />)
  expect(screen.getAllByText('Anyone with an email address at @company.com')).toHaveLength(1)
  expect(screen.getByText('Anyone with an email address at @team.company.com')).toBeInTheDocument()
  expect(screen.queryByText(/You \(/)).not.toBeInTheDocument()
  rerender(<EmailAccessFields {...props} value="anyone" />)
  expect(screen.queryByText(/Anyone with an email address at/)).not.toBeInTheDocument()
  expect(screen.getByText('This agent will accept emails from:')).toBeInTheDocument()
})
