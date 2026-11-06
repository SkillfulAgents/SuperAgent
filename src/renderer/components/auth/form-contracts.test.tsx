// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  changePassword: vi.fn(),
  updateUser: vi.fn(),
  toast: vi.fn(),
  user: { id: 'form-user', email: 'ada@example.test', name: 'Ada' },
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: mocks.apiFetch,
  consumeRedirectStash: () => null,
  peekRedirectStash: () => '/',
}))
vi.mock('@renderer/lib/auth-client', () => ({
  signIn: { email: mocks.signIn },
  signUp: { email: mocks.signUp },
  signOut: vi.fn(),
  authClient: { changePassword: mocks.changePassword, updateUser: mocks.updateUser },
}))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ user: mocks.user }) }))
vi.mock('@renderer/hooks/use-public-auth-config', () => ({
  usePublicAuthConfig: () => ({ config: { allowLocalAuth: true }, isLoading: false }),
}))
vi.mock('@renderer/components/settings/profile-photo', () => ({ ProfilePhoto: () => null }))
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }))

import { AuthPage } from './auth-page'
import { ForcePasswordChange } from './force-password-change'
import { ProfileSection } from '../settings/profile-section'

const config = {
  signupMode: 'open', allowLocalAuth: true, allowSocialAuth: false, providers: [],
  passwordMinLength: 8, passwordRequireComplexity: false,
  requireAdminApproval: false, hasUsers: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } })
}

function submit(button: HTMLElement) {
  const form = button.closest('form')
  if (!form) throw new Error('Expected a real form')
  // jsdom does not implement interactive constraint validation; the browser
  // suite covers native email validation and real button/keyboard submission.
  fireEvent.submit(form)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.user.name = 'Ada'
  mocks.apiFetch.mockResolvedValue(Response.json(config))
})
afterEach(cleanup)

describe('authentication forms with the real RHF and Zod resolver', () => {
  it('maps sign-in validation to fields and recovers from a failed submission without losing values', async () => {
    const failed = deferred<{ error: { message: string } }>()
    mocks.signIn.mockReturnValueOnce(failed.promise).mockResolvedValueOnce({ error: null })
    render(<AuthPage />)
    const button = await screen.findByTestId('signin-submit')
    submit(button)
    expect(await screen.findByText('Please enter a valid email address')).toBeVisible()
    expect(screen.getByText('Password is required')).toBeVisible()
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus())
    expect(mocks.signIn).not.toHaveBeenCalled()

    fill('Email', 'ada@example.test')
    fill('Password', 'existing-password')
    submit(button)
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledTimes(1))
    expect(button).toBeDisabled()
    expect(mocks.signIn).toHaveBeenLastCalledWith({ email: 'ada@example.test', password: 'existing-password' })
    await act(async () => { failed.resolve({ error: { message: 'Temporary login failure' } }) })
    expect(await screen.findByTestId('signin-error')).toHaveTextContent('Temporary login failure')
    expect(button).toBeEnabled()
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.test')
    expect(screen.getByLabelText('Password')).toHaveValue('existing-password')
    submit(button)
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.queryByTestId('signin-error')).not.toBeInTheDocument()
  })

  it('keeps signup complexity and confirmation errors on their fields and submits only validated account fields', async () => {
    mocks.apiFetch.mockResolvedValue(Response.json({ ...config, passwordMinLength: 12, passwordRequireComplexity: true }))
    mocks.signUp.mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce({ error: null })
    render(<AuthPage />)
    await screen.findByTestId('signin-submit')
    fireEvent.click(screen.getByRole('button', { name: /^Sign up$/ }))
    const button = await screen.findByTestId('signup-submit')
    fill('Name', 'Ada')
    fill('Email', 'ada@example.test')
    fill('Password', 'abcdefghijkl')
    fill('Confirm Password', 'different-value')
    submit(button)
    expect(await screen.findByText('Must contain an uppercase letter')).toBeVisible()
    expect(screen.getByText('Passwords do not match')).toBeVisible()
    await waitFor(() => expect(screen.getByLabelText('Password', { exact: true })).toHaveFocus())
    expect(mocks.signUp).not.toHaveBeenCalled()

    fill('Password', 'StrongPassword1!')
    fill('Confirm Password', 'StrongPassword1!')
    submit(button)
    expect(await screen.findByTestId('signup-error')).toHaveTextContent('Sign up failed. Please try again.')
    expect(button).toBeEnabled()
    expect(screen.queryByText('Passwords do not match')).not.toBeInTheDocument()
    submit(button)
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledTimes(2))
    expect(mocks.signUp).toHaveBeenLastCalledWith({ name: 'Ada', email: 'ada@example.test', password: 'StrongPassword1!' })
    await waitFor(() => expect(screen.queryByTestId('signup-error')).not.toBeInTheDocument())
  })

  it('uses a newly fetched password policy without discarding the forced-change draft', async () => {
    const policy = deferred<Response>()
    mocks.apiFetch.mockReturnValue(policy.promise)
    mocks.changePassword.mockResolvedValue({ error: { message: 'Temporary password rejected' } })
    render(<ForcePasswordChange />)
    const button = screen.getByRole('button', { name: 'Change Password' })
    fill('Temporary Password', 'temporary')
    fill('New Password', 'lowercase')
    fill('Confirm New Password', 'lowercase')
    submit(button)
    expect(await screen.findByText('Password must be at least 12 characters')).toBeVisible()
    expect(mocks.changePassword).not.toHaveBeenCalled()

    await act(async () => { policy.resolve(Response.json(config)) })
    expect(screen.getByLabelText('New Password')).toHaveAttribute('placeholder', 'At least 8 characters')
    expect(screen.getByLabelText('New Password')).toHaveValue('lowercase')
    submit(button)
    expect(await screen.findByText('Temporary password rejected')).toBeVisible()
    expect(screen.queryByText('Password must be at least 12 characters')).not.toBeInTheDocument()
    expect(mocks.changePassword).toHaveBeenCalledWith({
      currentPassword: 'temporary', newPassword: 'lowercase', revokeOtherSessions: true,
    })
    expect(button).toBeEnabled()
    submit(button)
    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledTimes(2))
  })

  it('adopts a stricter arriving policy before a forced-password request can be sent', async () => {
    const policy = deferred<Response>()
    mocks.apiFetch.mockReturnValue(policy.promise)
    render(<ForcePasswordChange />)
    fill('Temporary Password', 'temporary')
    fill('New Password', 'StrongPassword1!')
    fill('Confirm New Password', 'StrongPassword1!')
    await act(async () => { policy.resolve(Response.json({ ...config, passwordMinLength: 20, passwordRequireComplexity: true })) })
    submit(screen.getByRole('button', { name: 'Change Password' }))
    expect(await screen.findByText('Password must be at least 20 characters')).toBeVisible()
    expect(mocks.changePassword).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByLabelText('New Password')).toHaveFocus())
  })
})

describe('profile forms with the real RHF and Zod resolver', () => {
  it('keeps a failed name save dirty, then resets the baseline after success and session refresh', async () => {
    const firstSave = deferred<{ error: { message: string } }>()
    const retrySave = deferred<{ error: null }>()
    mocks.updateUser.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(retrySave.promise).mockResolvedValueOnce({ error: null })
    const view = render(<ProfileSection />)
    const button = screen.getByRole('button', { name: 'Save' })
    const input = screen.getByLabelText('Name')
    expect(button).toBeDisabled()
    expect(input).not.toHaveAttribute('readonly')
    fill('Name', '')
    submit(button)
    expect(await screen.findByText('Name is required')).toBeVisible()
    expect(mocks.updateUser).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus())
    fill('Name', 'Ada')
    await waitFor(() => expect(button).toBeDisabled())

    fill('Name', 'Ada Lovelace')
    submit(button)
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(1))
    expect(button).toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    await act(async () => { firstSave.resolve({ error: { message: 'Save unavailable' } }) })
    expect(await screen.findByText('Error: Save unavailable')).toBeVisible()
    expect(button).toBeEnabled()
    expect(input).not.toHaveAttribute('readonly')
    expect(screen.getByLabelText('Name')).toHaveValue('Ada Lovelace')
    submit(button)
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(2))
    expect(button).toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    await act(async () => { retrySave.resolve({ error: null }) })
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Name updated'))
    expect(button).toBeDisabled()
    expect(input).not.toHaveAttribute('readonly')
    expect(screen.queryByText('Error: Save unavailable')).not.toBeInTheDocument()
    fill('Name', 'Ada')
    await waitFor(() => expect(button).toBeEnabled())
    fill('Name', 'Ada Lovelace')
    await waitFor(() => expect(button).toBeDisabled())
    expect(mocks.updateUser).toHaveBeenCalledTimes(2)
    fill('Name', 'Next user edit')
    submit(button)
    await waitFor(() => expect(mocks.updateUser).toHaveBeenLastCalledWith({ name: 'Next user edit' }))
    await waitFor(() => expect(button).toBeDisabled())
    expect(input).not.toHaveAttribute('readonly')

    mocks.user.name = 'Refreshed session name'
    view.rerender(<ProfileSection />)
    expect(screen.getByLabelText('Name')).toHaveValue('Refreshed session name')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('recovers a password submission, preserves session policy, and discards secrets on reopen', async () => {
    const pending = deferred<{ error: { message: string } }>()
    mocks.changePassword.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ error: null })
    render(<ProfileSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(screen.getByLabelText('New password')).toHaveAttribute('placeholder', 'At least 8 characters'))
    fill('Current password', 'current-password')
    fill('New password', 'current-password')
    fill('Confirm new password', 'different-password')
    submit(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText('New password must be different from current password')).toBeVisible()
    expect(screen.getByText('Passwords do not match')).toBeVisible()
    expect(mocks.changePassword).not.toHaveBeenCalled()

    fill('New password', 'next-password')
    fill('Confirm new password', 'next-password')
    submit(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Changing password…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => { pending.resolve({ error: { message: 'Password service unavailable' } }) })
    expect(await screen.findByText('Error: Password service unavailable')).toBeVisible()
    expect(screen.getByLabelText('New password')).toHaveValue('next-password')
    submit(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Password changed'))
    expect(mocks.changePassword).toHaveBeenLastCalledWith({
      currentPassword: 'current-password', newPassword: 'next-password', revokeOtherSessions: false,
    })
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByLabelText('Current password')).toHaveValue('')
    expect(screen.getByLabelText('New password')).toHaveValue('')
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('')
    expect(screen.queryByText('Error: Password service unavailable')).not.toBeInTheDocument()
  })
})
