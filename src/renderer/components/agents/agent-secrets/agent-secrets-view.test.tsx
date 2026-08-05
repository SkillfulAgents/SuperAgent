// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSecretsView } from './agent-secrets-view'

const defaultSecret = {
  id: 'SHARED_KEY',
  key: 'Shared Key',
  envVar: 'SHARED_KEY',
  hasValue: true,
}

const mocks = vi.hoisted(() => ({
  reveal: vi.fn(),
  revealReset: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
  track: vi.fn(),
  canAdmin: true,
  querySlugs: [] as Array<string | null>,
  query: {
    data: [] as Array<{
      id: string
      key: string
      envVar: string
      hasValue: boolean
    }>,
    isLoading: false,
    isError: false,
    error: null as Error | null,
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn() }
})
vi.mock('@renderer/lib/perf', () => ({ useRenderTracker: () => {} }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mocks.track }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    isAuthMode: true,
    rolesReady: true,
    canAdminAgent: () => mocks.canAdmin,
  }),
}))
vi.mock('@renderer/hooks/use-secrets', () => ({
  useAgentSecrets: (slug: string | null) => {
    mocks.querySlugs.push(slug)
    return { ...mocks.query, refetch: mocks.refetch }
  },
  useCreateSecret: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateSecret: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteSecret: () => ({ mutateAsync: mocks.remove, isPending: false }),
  useRevealSecretValue: () => ({
    mutateAsync: mocks.reveal,
    reset: mocks.revealReset,
    isPending: false,
  }),
}))

describe('AgentSecretsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canAdmin = true
    mocks.querySlugs = []
    mocks.query = {
      data: [defaultSecret],
      isLoading: false,
      isError: false,
      error: null,
    }
    mocks.reveal.mockImplementation(
      async ({ agentSlug }: { agentSlug: string }) => `${agentSlug}-value`,
    )
    mocks.update.mockResolvedValue(defaultSecret)
    mocks.create.mockResolvedValue(defaultSecret)
    mocks.remove.mockResolvedValue(undefined)
  })

  it('drops revealed state when the route changes agents', async () => {
    const rendered = render(<AgentSecretsView agentSlug="agent-a" />)
    expect(mocks.track).toHaveBeenCalledWith('secrets_viewed', { agentSlug: 'agent-a' })
    fireEvent.click(screen.getByTestId('secret-reveal-SHARED_KEY'))
    expect(await screen.findByText('agent-a-value')).toBeInTheDocument()

    rendered.rerender(<AgentSecretsView agentSlug="agent-b" />)

    expect(screen.queryByText('agent-a-value')).not.toBeInTheDocument()
    expect(mocks.track).toHaveBeenLastCalledWith('secrets_viewed', { agentSlug: 'agent-b' })
  })

  it('refreshes an already-revealed row after editing its value', async () => {
    render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secret-reveal-SHARED_KEY'))
    expect(await screen.findByText('agent-a-value')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('secret-menu-SHARED_KEY'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByTestId('secret-dialog-value'), {
      target: { value: 'new-value' },
    })
    fireEvent.click(screen.getByTestId('secret-dialog-submit'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalled())

    expect(screen.getByText('new-value')).toBeInTheDocument()
    expect(screen.queryByText('agent-a-value')).not.toBeInTheDocument()
  })

  it('edits a key without revealing or resubmitting the stored value', async () => {
    render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secret-menu-SHARED_KEY'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    expect(screen.getByTestId('secret-dialog-value')).toHaveValue('')
    expect(screen.getByTestId('secret-dialog-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('secret-dialog-key'), {
      target: { value: 'Renamed Key' },
    })
    fireEvent.click(screen.getByTestId('secret-dialog-submit'))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        agentSlug: 'agent-a',
        secretId: 'SHARED_KEY',
        key: 'Renamed Key',
      }),
    )
    expect(mocks.reveal).not.toHaveBeenCalled()
  })

  it('treats a cleared edit value as unchanged instead of blanking the secret', async () => {
    render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secret-menu-SHARED_KEY'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    const valueInput = screen.getByTestId('secret-dialog-value')
    fireEvent.change(valueInput, { target: { value: 'x' } })
    fireEvent.change(valueInput, { target: { value: '' } })

    expect(screen.getByTestId('secret-dialog-submit')).toBeDisabled()
    expect(mocks.update).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('secret-dialog-key'), {
      target: { value: 'Renamed Key' },
    })
    fireEvent.click(screen.getByTestId('secret-dialog-submit'))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        agentSlug: 'agent-a',
        secretId: 'SHARED_KEY',
        key: 'Renamed Key',
      }),
    )
  })

  it('blocks keys that normalize to an empty environment variable', () => {
    render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secrets-add-button'))
    fireEvent.change(screen.getByTestId('secret-dialog-key'), {
      target: { value: 'Ключ' },
    })
    fireEvent.change(screen.getByTestId('secret-dialog-value'), {
      target: { value: 'secret' },
    })

    expect(screen.getByText('Env var: (invalid)')).toBeInTheDocument()
    expect(screen.getByTestId('secret-dialog-submit')).toBeDisabled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('blocks reserved keys and duplicate rename destinations', async () => {
    const rendered = render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secrets-add-button'))
    fireEvent.change(screen.getByTestId('secret-dialog-key'), {
      target: { value: 'Proxy Token' },
    })
    fireEvent.change(screen.getByTestId('secret-dialog-value'), {
      target: { value: 'secret' },
    })
    expect(screen.getByText(/PROXY_TOKEN \(reserved\)/)).toBeInTheDocument()
    expect(screen.getByTestId('secret-dialog-submit')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    mocks.query = {
      ...mocks.query,
      data: [
        defaultSecret,
        { id: 'OTHER', key: 'Other', envVar: 'OTHER', hasValue: true },
      ],
    }
    rendered.rerender(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secret-menu-SHARED_KEY'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByTestId('secret-dialog-key'), {
      target: { value: 'Other' },
    })

    expect(screen.getByText(/OTHER \(duplicate\)/)).toBeInTheDocument()
    expect(screen.getByTestId('secret-dialog-submit')).toBeDisabled()
  })

  it('does not query or render secret controls for a non-owner', () => {
    mocks.canAdmin = false
    render(<AgentSecretsView agentSlug="agent-a" />)

    expect(screen.getByText('Owner access required')).toBeInTheDocument()
    expect(screen.getByTestId('secrets-add-button')).toBeDisabled()
    expect(screen.queryByTestId('secret-row-SHARED_KEY')).not.toBeInTheDocument()
    expect(mocks.querySlugs.at(-1)).toBeNull()
  })

  it('keeps an open dialog and its draft through a transient list-query error', () => {
    const rendered = render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secrets-add-button'))
    fireEvent.change(screen.getByTestId('secret-dialog-key'), {
      target: { value: 'Draft Key' },
    })
    fireEvent.change(screen.getByTestId('secret-dialog-value'), {
      target: { value: 'draft-value' },
    })

    mocks.query = {
      data: [],
      isLoading: false,
      isError: true,
      error: new Error('Forbidden'),
    }
    rendered.rerender(<AgentSecretsView agentSlug="agent-a" />)

    expect(screen.getByText('Forbidden')).toBeInTheDocument()
    expect(screen.getByTestId('secret-dialog-key')).toHaveValue('Draft Key')

    mocks.query = {
      data: [defaultSecret],
      isLoading: false,
      isError: false,
      error: null,
    }
    rendered.rerender(<AgentSecretsView agentSlug="agent-a" />)
    expect(screen.getByTestId('secret-dialog-key')).toHaveValue('Draft Key')
  })

  it('shows the server list error and retries without presenting an empty list', () => {
    mocks.query = {
      data: [],
      isLoading: false,
      isError: true,
      error: new Error('Owner access required by server'),
    }
    render(<AgentSecretsView agentSlug="agent-a" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Owner access required by server')
    expect(screen.queryByText('No secrets yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('tracks concurrent reveals independently', async () => {
    let resolveA!: (value: string) => void
    let resolveB!: (value: string) => void
    const revealA = new Promise<string>((resolve) => {
      resolveA = resolve
    })
    const revealB = new Promise<string>((resolve) => {
      resolveB = resolve
    })
    mocks.query = {
      ...mocks.query,
      data: [
        { id: 'A', key: 'A', envVar: 'A', hasValue: true },
        { id: 'B', key: 'B', envVar: 'B', hasValue: true },
      ],
    }
    mocks.reveal.mockImplementation(
      ({ secretId }: { secretId: string }) => (secretId === 'A' ? revealA : revealB),
    )
    render(<AgentSecretsView agentSlug="agent-a" />)

    fireEvent.click(screen.getByTestId('secret-reveal-A'))
    fireEvent.click(screen.getByTestId('secret-reveal-B'))
    expect(screen.getByTestId('secret-reveal-A')).toBeDisabled()
    expect(screen.getByTestId('secret-reveal-B')).toBeDisabled()

    await act(async () => resolveA('value-a'))
    expect(await screen.findByText('value-a')).toBeInTheDocument()
    expect(screen.getByTestId('secret-reveal-A')).not.toBeDisabled()
    expect(screen.getByTestId('secret-reveal-B')).toBeDisabled()

    await act(async () => resolveB('value-b'))
    expect(await screen.findByText('value-b')).toBeInTheDocument()
    expect(screen.getByTestId('secret-reveal-B')).not.toBeDisabled()
  })

  it('reports reveal failures on the row that failed', async () => {
    mocks.query = {
      ...mocks.query,
      data: [
        { id: 'A', key: 'Alpha', envVar: 'A', hasValue: true },
        { id: 'B', key: 'Beta', envVar: 'B', hasValue: true },
      ],
    }
    mocks.reveal.mockRejectedValueOnce(new Error('Audit log is temporarily busy'))
    render(<AgentSecretsView agentSlug="agent-a" />)

    fireEvent.click(screen.getByTestId('secret-reveal-A'))

    expect(await screen.findByTestId('secret-reveal-error-A')).toHaveTextContent(
      "Couldn't reveal Alpha: Audit log is temporarily busy",
    )
    expect(screen.queryByTestId('secret-reveal-error-B')).not.toBeInTheDocument()
  })

  it('masks secret values without exposing a password field to password managers', () => {
    render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secrets-add-button'))
    const valueInput = screen.getByTestId('secret-dialog-value')

    expect(valueInput).toHaveAttribute('type', 'text')
    expect(valueInput).toHaveClass('[-webkit-text-security:disc]')
    expect(valueInput).toHaveAttribute('autocomplete', 'off')
    expect(valueInput).toHaveAttribute('data-1p-ignore', 'true')
    expect(valueInput).toHaveAttribute('data-bwignore', 'true')
    expect(valueInput).toHaveAttribute('data-form-type', 'other')
    expect(valueInput).toHaveAttribute('data-lpignore', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(valueInput).not.toHaveClass('[-webkit-text-security:disc]')
    fireEvent.click(screen.getByRole('button', { name: 'Hide value' }))
    expect(valueInput).toHaveClass('[-webkit-text-security:disc]')

    fireEvent.change(screen.getByTestId('secret-dialog-value'), {
      target: { value: 'temporary-secret' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByTestId('secrets-add-button'))

    expect(screen.getByTestId('secret-dialog-value')).toHaveValue('')
  })

  it('deletes a secret from the row action menu', async () => {
    render(<AgentSecretsView agentSlug="agent-a" />)
    fireEvent.click(screen.getByTestId('secret-menu-SHARED_KEY'))
    fireEvent.click(await screen.findByTestId('delete-secret-SHARED_KEY'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith({
        agentSlug: 'agent-a',
        secretId: 'SHARED_KEY',
      }),
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
