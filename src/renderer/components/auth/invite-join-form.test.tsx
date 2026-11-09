// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const state = vi.hoisted(() => ({
  details: null as Record<string, unknown> | null,
  claim: { status: 200, body: { email: 'dana@acme.test', pendingApproval: false } as Record<string, unknown> },
  requests: [] as Array<{ url: string; body?: unknown }>,
  signIn: vi.fn(async () => ({ error: null })),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    state.requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url === '/api/auth/invite/claim') return new Response(JSON.stringify(state.claim.body), { status: state.claim.status })
    return state.details
      ? new Response(JSON.stringify(state.details))
      : new Response(JSON.stringify({ error: 'This invitation has expired or was already used.' }), { status: 404 })
  }),
}))
vi.mock('@renderer/lib/auth-client', () => ({ signIn: { email: state.signIn } }))

import { InviteJoinForm } from './invite-join-form'

beforeEach(() => {
  state.requests = []
  state.signIn.mockClear()
  state.claim = { status: 200, body: { email: 'dana@acme.test', pendingApproval: false } }
  state.details = {
    name: 'Dana Whitfield', email: 'dana@acme.test', invitedBy: 'Ada Admin',
    passwordJoin: true, passwordMinLength: 8, passwordRequireComplexity: false,
  }
  window.history.replaceState(null, '', '/?invite=tok-123')
})
afterEach(cleanup)

describe('joining from an invite link', () => {
  it('greets them, sets their password, and signs them in', async () => {
    render(<InviteJoinForm token="tok-123" onDone={vi.fn()} />)
    expect(await screen.findByTestId('invite-join-greeting')).toHaveTextContent('Ada Admin invited you to Gamut.')
    expect(screen.getByLabelText('Email')).toHaveValue('dana@acme.test')
    expect(screen.getByLabelText('Name')).toHaveValue('Dana Whitfield')

    await userEvent.type(screen.getByLabelText('Password'), 'Password123!')
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'Password123!')
    await userEvent.click(screen.getByTestId('invite-join-submit'))

    await waitFor(() => expect(state.signIn).toHaveBeenCalledWith({ email: 'dana@acme.test', password: 'Password123!' }))
    expect(state.requests.at(-1)).toEqual({ url: '/api/auth/invite/claim', body: { token: 'tok-123', name: 'Dana Whitfield', password: 'Password123!' } })
    expect(window.location.search).toBe('')
  })

  it('checks the password against the deployment policy before sending', async () => {
    render(<InviteJoinForm token="tok-123" onDone={vi.fn()} />)
    await userEvent.type(await screen.findByLabelText('Password'), 'short')
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'short')
    await userEvent.click(screen.getByTestId('invite-join-submit'))
    expect(screen.getByTestId('invite-join-form-error')).toHaveTextContent('at least 8 characters')
    expect(state.requests.map((r) => r.url)).not.toContain('/api/auth/invite/claim')
  })

  it('tells them to wait when an admin must approve them', async () => {
    state.claim.body = { email: 'dana@acme.test', pendingApproval: true }
    const onPendingApproval = vi.fn()
    render(<InviteJoinForm token="tok-123" onDone={vi.fn()} onPendingApproval={onPendingApproval} />)
    await userEvent.type(await screen.findByLabelText('Password'), 'Password123!')
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'Password123!')
    await userEvent.click(screen.getByTestId('invite-join-submit'))
    expect(await screen.findByTestId('pending-approval')).toBeInTheDocument()
    expect(onPendingApproval).toHaveBeenCalledWith(true)
    expect(state.signIn).not.toHaveBeenCalled()
  })

  it('sends them to single sign-on where passwords are off', async () => {
    state.details = { ...state.details, passwordJoin: false }
    render(<InviteJoinForm token="tok-123" onDone={vi.fn()} />)
    expect(await screen.findByTestId('invite-join-sso')).toHaveTextContent('Sign in with single sign-on as dana@acme.test to join.')
  })

  it('says a used link is used, and offers the sign-in form', async () => {
    state.details = null
    const onDone = vi.fn()
    render(<InviteJoinForm token="tok-123" onDone={onDone} />)
    expect(await screen.findByTestId('invite-join-error')).toHaveTextContent('expired or was already used')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onDone).toHaveBeenCalled()
  })
})
