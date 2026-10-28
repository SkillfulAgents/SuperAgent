// @vitest-environment jsdom
import { createEvent, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSwitchItem,
  ContextMenuTrigger,
} from './context-menu'

describe('ContextMenu touch and switch options', () => {
  it('suppresses touch long-press when an explicit gesture mode owns the hold', () => {
    renderWithProviders(
      <ContextMenu>
        <ContextMenuTrigger disableTouchLongPress>
          <div>Agent card</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSwitchItem checked>Expanded</ContextMenuSwitchItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    const trigger = screen.getByText('Agent card')
    const pointerDown = createEvent.pointerDown(trigger, {
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    })
    fireEvent(trigger, pointerDown)

    expect(pointerDown.defaultPrevented).toBe(true)
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Expanded' })).not.toBeInTheDocument()
  })

  it('renders an accessible switch row and reports its next value', () => {
    const onCheckedChange = vi.fn()
    renderWithProviders(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>Agent card</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSwitchItem checked onCheckedChange={onCheckedChange}>
            Expanded
          </ContextMenuSwitchItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('Agent card'))
    const option = screen.getByRole('menuitemcheckbox', { name: 'Expanded' })
    expect(option).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(option)
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })
})
