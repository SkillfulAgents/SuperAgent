// @vitest-environment jsdom
import { createEvent, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuMoreButton,
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

describe('ContextMenuMoreButton', () => {
  // A row the way the sidebar builds one: the trigger wraps the link and the
  // button, which can't nest inside the <a>.
  function renderRow({ anchor, onLinkClick = vi.fn(), onOpenChange }: {
    anchor?: 'below' | 'beside'
    onLinkClick?: (e: React.MouseEvent) => void
    onOpenChange?: (open: boolean) => void
  } = {}) {
    const onContextMenu = vi.fn()
    renderWithProviders(
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
          <div data-testid="row">
            <a href="/session" onClick={onLinkClick}>Weekly report</a>
            <ContextMenuMoreButton label="Options for Weekly report" anchor={anchor} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
    return { onContextMenu, onLinkClick, button: screen.getByRole('button', { name: 'Options for Weekly report' }) }
  }

  it('opens the menu its target opens on right-click, without clicking through to the row', () => {
    const onOpenChange = vi.fn()
    const { button, onLinkClick } = renderRow({ onOpenChange })

    fireEvent.click(button)

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.getByTestId('row')).toHaveAttribute('data-state', 'open')
    // The caller's own onOpenChange still hears about it.
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(onLinkClick).not.toHaveBeenCalled()
  })

  it.each([
    ['below', { clientX: 100, clientY: 34 }],
    ['beside', { clientX: 120, clientY: 30 }],
  ] as const)('anchors the menu %s the button', (anchor, point) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, right: 120, top: 10, bottom: 30 } as DOMRect
    )
    try {
      const { button, onContextMenu } = renderRow({ anchor })
      fireEvent.click(button)
      expect(onContextMenu.mock.calls[0][0]).toMatchObject(point)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reports the menu state, however it was opened', () => {
    const { button } = renderRow()
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.contextMenu(screen.getByText('Weekly report'))

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button).toHaveAttribute('data-state', 'open')
  })

  it('opens from the keyboard even inside a row that cancels Enter and Space', async () => {
    // Like a sortable row's keyboard sensor, which picks the row up instead.
    const onRowKeyDown = vi.fn((e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault()
    })
    renderWithProviders(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- stands in for dnd-kit's listeners on a sortable <li>
      <div onKeyDown={onRowKeyDown}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div>
              <a href="/session">Weekly report</a>
              <ContextMenuMoreButton label="Options for Weekly report" />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Rename</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
    screen.getByRole('button', { name: 'Options for Weekly report' }).focus()

    await userEvent.keyboard('{Enter}')

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(onRowKeyDown).not.toHaveBeenCalled()
  })

  it('refuses to render outside a ContextMenu', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => renderWithProviders(<ContextMenuMoreButton label="Options" />)).toThrow(
        'ContextMenuMoreButton must be rendered inside a <ContextMenu>'
      )
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('swallows the click that follows a long-press on a link inside the trigger', () => {
    // A long-press opens the menu and the finger's lift then clicks the link;
    // the link's own handler must already see the click cancelled (TanStack's
    // Link skips navigation when it is).
    const seen: boolean[] = []
    renderRow({ onLinkClick: (e) => seen.push(e.defaultPrevented) })
    const link = screen.getByText('Weekly report')

    fireEvent.click(link)
    fireEvent.contextMenu(link)
    fireEvent.click(link)

    expect(seen).toEqual([false, true])
  })
})
