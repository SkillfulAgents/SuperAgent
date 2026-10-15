// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const userMock = vi.fn()
const mutateMock = vi.fn()

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => userMock(),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useGlobalInstructions: () => ({ isLoading: false, data: { globalInstructions: 'Be kind' } }),
  useUpdateSettings: () => ({ mutate: mutateMock, isPending: false, error: null }),
}))

import { GlobalInstructionsTab } from './global-instructions-tab'

describe('GlobalInstructionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the guidance read-only to a non-admin in auth mode', () => {
    userMock.mockReturnValue({ isAuthMode: true, isAdmin: false })
    render(<GlobalInstructionsTab />)

    const editor = screen.getByTestId('global-instructions-editor')
    expect(editor).toHaveValue('Be kind')
    expect(editor).toHaveAttribute('readonly')
    expect(screen.queryByTestId('global-instructions-save')).not.toBeInTheDocument()
    expect(screen.getByText(/Only admins can edit it/)).toBeInTheDocument()
  })

  it.each([
    ['an admin in auth mode', { isAuthMode: true, isAdmin: true }],
    ['the user of a non-auth install', { isAuthMode: false, isAdmin: false }],
  ])('lets %s edit and save, trimmed', async (_label, user) => {
    userMock.mockReturnValue(user)
    render(<GlobalInstructionsTab />)

    const save = screen.getByTestId('global-instructions-save')
    expect(save).toBeDisabled()

    const editor = screen.getByTestId('global-instructions-editor')
    await userEvent.clear(editor)
    await userEvent.type(editor, '  Cite sources  ')
    await userEvent.click(save)

    expect(mutateMock).toHaveBeenCalledWith({ globalInstructions: 'Cite sources' }, expect.anything())
  })
})
