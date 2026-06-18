// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineEditableTitle } from './inline-editable-title'

describe('InlineEditableTitle', () => {
  it('enters edit mode when the title is clicked', async () => {
    const user = userEvent.setup()

    render(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={vi.fn()}
        displayTestId="title"
        inputTestId="title-input"
      />,
    )

    await user.click(screen.getByTestId('title'))

    expect(screen.getByTestId('title-input')).toHaveValue('Daily report')
  })

  it('saves a trimmed title from the save button', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={onSave}
        displayTestId="title"
        inputTestId="title-input"
        saveButtonTestId="title-save"
      />,
    )

    await user.click(screen.getByTestId('title'))
    await user.clear(screen.getByTestId('title-input'))
    await user.type(screen.getByTestId('title-input'), '  Weekly report  ')
    await user.click(screen.getByTestId('title-save'))

    expect(onSave).toHaveBeenCalledWith('Weekly report')
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument()
  })

  it('saves from Enter', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={onSave}
        displayTestId="title"
        inputTestId="title-input"
      />,
    )

    await user.click(screen.getByTestId('title'))
    await user.clear(screen.getByTestId('title-input'))
    await user.type(screen.getByTestId('title-input'), 'Weekly report{Enter}')

    expect(onSave).toHaveBeenCalledWith('Weekly report')
  })

  it('cancels from Escape without saving', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()

    render(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={onSave}
        displayTestId="title"
        inputTestId="title-input"
      />,
    )

    await user.click(screen.getByTestId('title'))
    await user.type(screen.getByTestId('title-input'), ' changed')
    await user.keyboard('{Escape}')

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('title')).toHaveTextContent('Daily report')
  })

  it('closes without saving blank or unchanged titles', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()

    const { rerender } = render(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={onSave}
        displayTestId="title"
        inputTestId="title-input"
        saveButtonTestId="title-save"
      />,
    )

    await user.click(screen.getByTestId('title'))
    await user.click(screen.getByTestId('title-save'))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument()

    rerender(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={onSave}
        displayTestId="title"
        inputTestId="title-input"
        saveButtonTestId="title-save"
      />,
    )

    await user.click(screen.getByTestId('title'))
    await user.clear(screen.getByTestId('title-input'))
    await user.type(screen.getByTestId('title-input'), '   ')
    await user.click(screen.getByTestId('title-save'))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument()
  })

  it('keeps editing and reports errors when save fails', async () => {
    const user = userEvent.setup()
    const error = new Error('Nope')
    const onSave = vi.fn().mockRejectedValue(error)
    const onError = vi.fn()

    render(
      <InlineEditableTitle
        value="Daily report"
        canEdit
        isSaving={false}
        onSave={onSave}
        onError={onError}
        displayTestId="title"
        inputTestId="title-input"
        saveButtonTestId="title-save"
      />,
    )

    await user.click(screen.getByTestId('title'))
    await user.clear(screen.getByTestId('title-input'))
    await user.type(screen.getByTestId('title-input'), 'Weekly report')
    await user.click(screen.getByTestId('title-save'))

    expect(onError).toHaveBeenCalledWith(error)
    expect(screen.getByTestId('title-input')).toBeInTheDocument()
  })

  it('renders read-only headings when editing is disabled', () => {
    render(
      <InlineEditableTitle
        value="Daily report"
        canEdit={false}
        isSaving={false}
        onSave={vi.fn()}
        readOnlyAs="h2"
        displayTestId="title"
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Daily report' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Daily report' })).not.toBeInTheDocument()
  })
})
