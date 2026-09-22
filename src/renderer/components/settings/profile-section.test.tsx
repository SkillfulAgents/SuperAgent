// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const publicAuthConfigMock = vi.fn()
const updateUserMock = vi.fn()
const toastSuccessMock = vi.fn()

vi.mock('@renderer/hooks/use-public-auth-config', () => ({
  usePublicAuthConfig: () => publicAuthConfigMock(),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    user: { id: 'u1', email: 'a@example.com', name: 'Ada' },
  }),
}))

vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {
    updateUser: (...args: unknown[]) => updateUserMock(...args),
    changePassword: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: vi.fn(),
  },
}))

// usePasswordPolicy fetches /api/auth-config on mount; answer with a non-OK
// response so the default policy stands and nothing hits the network.
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
}))

import { ProfileSection } from './profile-section'

describe('ProfileSection', () => {
  beforeEach(() => {
    updateUserMock.mockReset()
    toastSuccessMock.mockReset()
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: false,
    })
  })

  it('shows the signed-in email read-only and the name in an editable field', () => {
    render(<ProfileSection />)
    expect(screen.getByText('a@example.com')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Ada')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('hides Change password when local auth is off', () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: false },
      isLoading: false,
    })
    render(<ProfileSection />)
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument()
  })

  it('hides Change password while auth-config is loading', () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: true,
    })
    render(<ProfileSection />)
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument()
  })

  it('shows Change password whenever local auth is enabled', () => {
    render(<ProfileSection />)
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
  })

  it('expands the password form in place and collapses it on Cancel', () => {
    render(<ProfileSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
  })

  it('saves an edited name, confirms with a toast, and re-disables Save', async () => {
    updateUserMock.mockResolvedValue({ error: null })
    render(<ProfileSection />)

    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    await waitFor(() => expect(save).toBeEnabled())

    fireEvent.click(save)
    await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ name: 'Ada Lovelace' }))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith('Name updated'))
    await waitFor(() => expect(save).toBeDisabled())
  })

  it('surfaces a failed name update inline', async () => {
    updateUserMock.mockResolvedValue({ error: { message: 'Name is taken' } })
    render(<ProfileSection />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    const save = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)

    // RequestError prefixes its default "Error" label to the message.
    expect(await screen.findByText('Error: Name is taken')).toBeInTheDocument()
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})
