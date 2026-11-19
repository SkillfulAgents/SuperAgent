// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockMutateAsync, mockToastError } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockToastError: vi.fn(),
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useDeleteAgent: () => ({ mutateAsync: mockMutateAsync }),
  useRouteAgentId: () => undefined,
}))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

import { DeleteAgentConfirmDialog } from './delete-agent-confirm-dialog'

/* see slide-to-confirm.test.tsx: in jsdom clientX is the handle's own
   coordinate, and the default track has 224px of travel */
const slide = (handle: HTMLElement, to: number) => {
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to })
}

const flush = () => act(async () => {})

beforeEach(() => {
  mockMutateAsync.mockReset()
  mockToastError.mockReset()
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeleteAgentConfirmDialog', () => {
  it('confirms with a slide rather than a click', async () => {
    mockMutateAsync.mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    const onDeleted = vi.fn()
    render(
      <DeleteAgentConfirmDialog
        agentSlug="helper"
        agentName="Helper"
        open
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />,
    )
    const handle = screen.getByTestId('confirm-delete-agent-button')
    expect(handle).toHaveAttribute('aria-label', 'Slide to delete')
    expect(screen.getByRole('heading', { name: 'Delete Helper?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

    // A click is exactly what the slide exists to ignore.
    fireEvent.click(handle)
    expect(mockMutateAsync).not.toHaveBeenCalled()

    slide(handle, 120)
    expect(mockMutateAsync).not.toHaveBeenCalled()

    slide(handle, 400)
    expect(mockMutateAsync).toHaveBeenCalledWith('helper')
    await flush()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('a failed delete toasts, keeps the dialog open and re-arms the slider', async () => {
    mockMutateAsync.mockRejectedValue(new Error('agent is busy'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onOpenChange = vi.fn()
    render(<DeleteAgentConfirmDialog agentSlug="helper" agentName="Helper" open onOpenChange={onOpenChange} />)
    const handle = screen.getByTestId('confirm-delete-agent-button')

    slide(handle, 400)
    await flush()

    expect(mockToastError).toHaveBeenCalledWith('agent is busy')
    expect(consoleError).toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(handle).toHaveAttribute('aria-label', 'Slide to delete')

    mockMutateAsync.mockResolvedValue(undefined)
    slide(handle, 400)
    await flush()
    expect(mockMutateAsync).toHaveBeenCalledTimes(2)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    consoleError.mockRestore()
  })

  it('the X in the corner is the cancel', () => {
    const onOpenChange = vi.fn()
    render(<DeleteAgentConfirmDialog agentSlug="helper" agentName="Helper" open onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByTestId('cancel-delete-agent-button'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })
})
