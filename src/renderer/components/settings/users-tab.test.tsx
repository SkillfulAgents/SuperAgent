// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@renderer/components/ui/tooltip'

const openExternalUrl = vi.fn()
const publicAuthConfigMock = vi.fn()
const listUsersMock = vi.fn()

vi.mock('@renderer/lib/open-external', () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: { id: 'admin-1' } }),
}))

vi.mock('@renderer/hooks/use-public-auth-config', () => ({
  usePublicAuthConfig: () => publicAuthConfigMock(),
}))

vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {
    admin: {
      listUsers: (...args: unknown[]) => listUsersMock(...args),
      setRole: vi.fn(),
      banUser: vi.fn(),
      unbanUser: vi.fn(),
      removeUser: vi.fn(),
    },
  },
}))

import { UsersTab } from './users-tab'

function renderUsers(props?: { platformControlled?: boolean; platformInviteHref?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UsersTab {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('UsersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: false,
    })
    listUsersMock.mockResolvedValue({ data: { users: [], total: 0 } })
  })

  it('opens Platform Team for invite when platform-controlled with href', async () => {
    const user = userEvent.setup()
    renderUsers({
      platformControlled: true,
      platformInviteHref: 'https://platform.example/dashboard/organizations/org_1?tab=team',
    })
    expect(screen.getByText(/Invite members on Platform/i)).toBeInTheDocument()
    await user.click(screen.getByTestId('users-invite-button'))
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://platform.example/dashboard/organizations/org_1?tab=team',
    )
  })

  it('disables invite and skips local dialog when platform-controlled without href', () => {
    renderUsers({ platformControlled: true })
    expect(screen.getByText(/Invite members on Platform/i)).toBeInTheDocument()
    expect(screen.getByTestId('users-invite-button')).toBeDisabled()
    expect(screen.queryByText('Invite User')).not.toBeInTheDocument()
  })

  it('keeps local invite when not platform-controlled', async () => {
    const user = userEvent.setup()
    renderUsers()
    await user.click(screen.getByTestId('users-invite-button'))
    expect(openExternalUrl).not.toHaveBeenCalled()
    expect(screen.getByText('Invite User')).toBeInTheDocument()
  })

  it('keeps Reset Password in platform-controlled mode when local auth is enabled', async () => {
    listUsersMock.mockResolvedValue({
      data: {
        users: [
          {
            id: 'member-1',
            name: 'Member',
            email: 'member@example.com',
            role: 'user',
            createdAt: new Date(),
          },
        ],
        total: 1,
      },
    })

    renderUsers({ platformControlled: true, platformInviteHref: 'https://platform.example/team' })

    expect(await screen.findByTitle('Reset password')).toBeInTheDocument()
  })

  it('hides Reset Password when local auth is disabled', async () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: false },
      isLoading: false,
    })
    listUsersMock.mockResolvedValue({
      data: {
        users: [
          {
            id: 'member-1',
            name: 'Member',
            email: 'member@example.com',
            role: 'user',
            createdAt: new Date(),
          },
        ],
        total: 1,
      },
    })

    renderUsers()

    expect(await screen.findByTestId('user-row-member@example.com')).toBeInTheDocument()
    expect(screen.queryByTitle('Reset password')).not.toBeInTheDocument()
  })
})
