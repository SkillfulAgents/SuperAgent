// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const openExternalUrl = vi.fn()

vi.mock('@renderer/lib/open-external', () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: { id: 'admin-1' } }),
}))

vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {
    admin: {
      listUsers: vi.fn(async () => ({ data: { users: [], total: 0 } })),
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
      <UsersTab {...props} />
    </QueryClientProvider>,
  )
}

describe('UsersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
