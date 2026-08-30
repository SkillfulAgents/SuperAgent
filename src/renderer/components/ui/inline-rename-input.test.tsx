// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { InlineRenameInput } from './inline-rename-input'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

function renderField(overrides: Partial<ComponentProps<typeof InlineRenameInput>> = {}) {
  const onSave = overrides.onSave ?? vi.fn().mockResolvedValue(undefined)
  const onDone = overrides.onDone ?? vi.fn()
  render(
    <>
      <InlineRenameInput
        currentName="New Session"
        noun="session"
        ariaLabel="Session name"
        testId="name-input"
        onSave={onSave}
        onDone={onDone}
        {...overrides}
      />
      <button type="button" data-testid="other">Other</button>
    </>,
  )
  return { onSave, onDone }
}

describe('InlineRenameInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('selects the current name on mount so typing replaces it', () => {
    renderField()
    const input = screen.getByTestId('name-input') as HTMLInputElement
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('New Session'.length)
  })

  it('saves a trimmed name on Enter', async () => {
    const user = userEvent.setup()
    const { onSave, onDone } = renderField()
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), '  Q3 plan  {Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Q3 plan'))
    expect(onDone).toHaveBeenCalled()
  })

  it('saves on leave', async () => {
    const user = userEvent.setup()
    const { onSave } = renderField()
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), 'Q3 plan')
    await user.tab()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Q3 plan'))
  })

  it('abandons on Escape without saving', async () => {
    const user = userEvent.setup()
    const { onSave, onDone } = renderField()
    await user.type(screen.getByTestId('name-input'), ' changed')
    await user.keyboard('{Escape}')
    expect(onSave).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('treats an unchanged or blank name as a cancel', async () => {
    const user = userEvent.setup()
    const { onSave, onDone } = renderField()
    await user.type(screen.getByTestId('name-input'), '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('treats a name edited back to the snapshot as a cancel', async () => {
    const user = userEvent.setup()
    const { onSave, onDone } = renderField()
    await user.type(screen.getByTestId('name-input'), ' extra')
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), 'New Session{Enter}')
    expect(onSave).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('keeps the typed name when currentName updates while editing', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onDone = vi.fn()
    const { rerender } = render(
      <InlineRenameInput
        currentName="New Session"
        noun="session"
        ariaLabel="Session name"
        testId="name-input"
        onSave={onSave}
        onDone={onDone}
      />,
    )
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), 'Quarterly numbers')
    rerender(
      <InlineRenameInput
        currentName="Reviewing the Q3 spreadsheet"
        noun="session"
        ariaLabel="Session name"
        testId="name-input"
        onSave={onSave}
        onDone={onDone}
      />,
    )
    expect(screen.getByTestId('name-input')).toHaveValue('Quarterly numbers')
  })

  it('stays open with a toast when save fails', async () => {
    const user = userEvent.setup()
    const error = new Error('Nope')
    const { onSave, onDone } = renderField({
      onSave: vi.fn().mockRejectedValue(error),
    })
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), 'Q3 plan{Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByTestId('name-input')).toHaveValue('Q3 plan')
    expect(toast.error).toHaveBeenCalledWith('Failed to rename session', {
      description: 'Nope',
    })
  })

  it('locks the field while save is in flight and holds the leaving click', async () => {
    const user = userEvent.setup()
    let resolveSave: (() => void) | undefined
    const otherClick = vi.fn()
    const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve }))
    const onDone = vi.fn()
    render(
      <>
        <InlineRenameInput
          currentName="New Session"
          noun="session"
          ariaLabel="Session name"
          testId="name-input"
          onSave={onSave}
          onDone={onDone}
        />
        <button type="button" data-testid="other" onClick={otherClick}>Other</button>
      </>,
    )
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), 'Q3 plan')
    await user.click(screen.getByTestId('other'))
    expect(onSave).toHaveBeenCalled()
    expect(screen.getByTestId('name-input')).toBeDisabled()
    expect(otherClick).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    resolveSave?.()
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    await waitFor(() => expect(otherClick).toHaveBeenCalled())
  })

  it('drops the held click when save fails', async () => {
    const user = userEvent.setup()
    const otherClick = vi.fn()
    render(
      <>
        <InlineRenameInput
          currentName="New Session"
          noun="session"
          ariaLabel="Session name"
          testId="name-input"
          onSave={vi.fn().mockRejectedValue(new Error('Nope'))}
          onDone={vi.fn()}
        />
        <button type="button" data-testid="other" onClick={otherClick}>Other</button>
      </>,
    )
    await user.clear(screen.getByTestId('name-input'))
    await user.type(screen.getByTestId('name-input'), 'Q3 plan')
    await user.click(screen.getByTestId('other'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(otherClick).not.toHaveBeenCalled()
    expect(screen.getByTestId('name-input')).toBeInTheDocument()
  })
})
