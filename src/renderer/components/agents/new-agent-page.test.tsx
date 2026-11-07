// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CreateAgentFormProps } from './create-agent-form'

const { mockPush, mockUpdateSettings, mockBack, search, captured } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUpdateSettings: vi.fn(),
  // Whether there was a step to go back to.
  mockBack: vi.fn(() => false),
  search: {} as { from?: string; section?: string; surface?: string },
  captured: {} as { onAgentCreated?: CreateAgentFormProps['onAgentCreated']; surface?: string },
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: mockPush } }),
  useSearch: () => search,
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUpdateUserSettings: () => ({ mutateAsync: mockUpdateSettings }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
// The form itself is covered by create-agent-form.test.tsx; here only the
// page's way out and what it does once an agent exists.
vi.mock('@renderer/components/wizard/create-agent-step', () => ({
  CreateAgentScreen: (props: { footer: (f: unknown) => React.ReactNode; nameTitle: string; onClose?: () => void } & typeof captured) => {
    captured.onAgentCreated = props.onAgentCreated
    captured.surface = props.surface
    return (
      <div>
        {props.onClose && <button type="button" data-testid="create-agent-close" onClick={props.onClose}>Close</button>}
        <h2>{props.nameTitle}</h2>
        {props.footer({ back: mockBack })}
      </div>
    )
  },
}))

import { toast } from 'sonner'
import { NewAgentPage } from './new-agent-page'

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(search)) delete search[key as keyof typeof search]
  mockUpdateSettings.mockResolvedValue({})
  mockBack.mockReturnValue(false)
})

describe('NewAgentPage', () => {
  it('goes Back to where it was opened from', async () => {
    search.from = '/agents/alpha'
    render(<NewAgentPage />)
    await userEvent.click(screen.getByTestId('new-agent-back'))
    expect(mockPush).toHaveBeenCalledWith('/agents/alpha')
  })

  it('steps Back within the flow instead of leaving while there is a step behind', async () => {
    search.from = '/agents/alpha'
    mockBack.mockReturnValue(true)
    render(<NewAgentPage />)
    await userEvent.click(screen.getByTestId('new-agent-back'))
    expect(mockBack).toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('closes from either step with the X', async () => {
    search.from = '/agents/alpha'
    mockBack.mockReturnValue(true)
    render(<NewAgentPage />)
    await userEvent.click(screen.getByTestId('create-agent-close'))
    expect(mockPush).toHaveBeenCalledWith('/agents/alpha')
    expect(mockBack).not.toHaveBeenCalled()
  })

  it('goes Back home on a cold deep link', async () => {
    render(<NewAgentPage />)
    await userEvent.click(screen.getByTestId('new-agent-back'))
    expect(mockPush).toHaveBeenCalledWith('/')
  })

  it('hands the opening surface to the form for analytics', () => {
    search.surface = 'home'
    render(<NewAgentPage />)
    expect(captured.surface).toBe('home')
  })

  it('files the new agent into the section it was opened from', async () => {
    search.section = 'f1'
    render(<NewAgentPage />)
    await captured.onAgentCreated?.({ slug: 'new-agent-abc' })
    const updater = mockUpdateSettings.mock.calls[0][0] as (current: { agentFolderAssignments?: Record<string, string> }) => unknown
    expect(updater({ agentFolderAssignments: { other: 'f2' } })).toEqual({
      agentFolderAssignments: { other: 'f2', 'new-agent-abc': 'f1' },
    })
  })

  it('leaves the agent unfiled without a section', async () => {
    render(<NewAgentPage />)
    await captured.onAgentCreated?.({ slug: 'new-agent-abc' })
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })

  it('reports a failed filing without failing the create', async () => {
    search.section = 'f1'
    mockUpdateSettings.mockRejectedValueOnce(new Error('offline'))
    render(<NewAgentPage />)
    await expect(captured.onAgentCreated?.({ slug: 'new-agent-abc' })).resolves.toBeUndefined()
    expect(toast.error).toHaveBeenCalledWith('Agent created, but could not add it to the section', expect.anything())
  })
})
