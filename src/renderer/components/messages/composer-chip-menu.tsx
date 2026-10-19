import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import type { ChipMenuProps } from './composer-chips'

/**
 * A chip kind's menu, opened where the chip was right-clicked. Dismissing it
 * closes the kind's menu. An item that opens a dialog calls `preventDefault` in
 * its `onSelect` and renders the dialog in the menu's place.
 */
export function ChipMenuAt({ anchor, onClose, children }: Pick<ChipMenuProps, 'anchor' | 'onClose'> & { children: ReactNode }) {
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose() }}>
      {/* On body, so a transformed composer cannot offset the fixed anchor. */}
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: anchor.x, top: anchor.y }} />
        </DropdownMenuTrigger>,
        document.body
      )}
      <DropdownMenuContent
        align="start"
        sideOffset={0}
        data-testid="chip-menu"
        // The editor takes focus back once the menu is gone.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
