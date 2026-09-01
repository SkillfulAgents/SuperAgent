// @vitest-environment jsdom
import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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

  it('moves one selection surface between highlighted rows', async () => {
    renderWithProviders(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>Agent card</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Settings</ContextMenuItem>
          <ContextMenuItem className="text-destructive">Delete Agent</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('Agent card'))
    const settings = screen.getByRole('menuitem', { name: 'Settings' })
    const deleteAgent = screen.getByRole('menuitem', { name: 'Delete Agent' })
    const surface = settings.closest('[data-context-menu-surface]') as HTMLElement
    const indicator = surface.querySelector(
      '[data-context-menu-selection-indicator]'
    ) as HTMLElement

    surface.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ x: 20, y: 30, width: 200, height: 100 })
    )
    settings.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ x: 24, y: 34, width: 192, height: 26 })
    )
    deleteAgent.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ x: 24, y: 64, width: 192, height: 26 })
    )

    settings.setAttribute('data-highlighted', '')
    fireEvent.pointerMove(settings)
    await waitFor(() => {
      expect(indicator).toHaveAttribute('data-visible')
      expect(indicator).toHaveStyle({
        width: '192px',
        height: '26px',
        transform: 'translate3d(4px, 4px, 0)',
      })
    })

    settings.removeAttribute('data-highlighted')
    deleteAgent.setAttribute('data-highlighted', '')
    fireEvent.pointerMove(deleteAgent)
    await waitFor(() => {
      expect(indicator).toHaveStyle({ transform: 'translate3d(4px, 34px, 0)' })
      expect(indicator).toHaveAttribute('data-destructive')
    })
  })
})
