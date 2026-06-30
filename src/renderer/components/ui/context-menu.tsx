import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { Check, ChevronRight, Circle } from "lucide-react"

import { cn } from "@shared/lib/utils"

const ContextMenu = ContextMenuPrimitive.Root

// Radix's Trigger already opens the menu on a ~700ms long-press for touch/pen, so
// it works out of the box on Android. On iOS, though, the text-selection
// magnifier and the link-preview popover for wrapped <a> elements pre-empt the
// long-press. Suppress both on coarse pointers so the built-in gesture wins —
// every <ContextMenu> call site inherits this. All suppression is `touch:`-gated
// (`@media (hover: none) and (pointer: coarse)`), so a mouse keeps right-click and
// normal text selection exactly as before.
//
// We also add the native iOS "press-highlight" feedback: on a touch/pen press the
// target quickly scales down a touch (~0.96 over 140ms), so the user gets instant
// "something's happening" feedback during the long-press hold — matching how iOS
// briefly shrinks an element before the context menu lifts in. `data-pressing` is
// set only for touch/pen and the scale is `touch:`-gated, so a mouse is never
// scaled. The press clears on lift, cancel, or a >10px move (so a scroll doesn't
// trigger it).
const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>(({ className, style, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, ...props }, ref) => {
  const pressStart = React.useRef<{ x: number; y: number } | null>(null)
  const longPressTimer = React.useRef<number>()

  const setPressing = (el: HTMLElement, on: boolean) => {
    if (on) el.setAttribute('data-pressing', '')
    else el.removeAttribute('data-pressing')
  }
  const clearLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = undefined
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      pressStart.current = { x: e.clientX, y: e.clientY }
      setPressing(e.currentTarget, true)
      // Open the menu sooner than Radix's built-in ~700ms long-press: after a
      // shorter hold, dispatch a synthetic `contextmenu` at the press point. Radix
      // opens from that and clears its own (slower) timer, so the menu follows the
      // press-feedback without the extra wait. (iOS default Haptic Touch ≈ 500ms.)
      const el = e.currentTarget
      const { clientX, clientY } = e
      clearLongPress()
      longPressTimer.current = window.setTimeout(() => {
        el.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }),
        )
      }, 400)
    }
    onPointerDown?.(e)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (pressStart.current) {
      const moved =
        Math.abs(e.clientX - pressStart.current.x) > 10 ||
        Math.abs(e.clientY - pressStart.current.y) > 10
      if (moved) {
        pressStart.current = null
        setPressing(e.currentTarget, false)
        clearLongPress()
      }
    }
    onPointerMove?.(e)
  }
  const endPress = (e: React.PointerEvent<HTMLElement>) => {
    pressStart.current = null
    setPressing(e.currentTarget, false)
    clearLongPress()
  }
  const handlePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    endPress(e)
    onPointerUp?.(e)
  }
  const handlePointerCancel = (e: React.PointerEvent<HTMLElement>) => {
    endPress(e)
    onPointerCancel?.(e)
  }
  // When a long-press opens the menu, the trigger is often an <a> (e.g. a sidebar
  // session row / agent card). On finger-lift the trailing click would navigate
  // that link — swallow it while the menu is open. Must be `onClick` (not
  // capture): AppLink owns onClickCapture, and TanStack's Link skips navigation
  // when its onClick is defaultPrevented. A normal tap never opens the menu, so it
  // still navigates; desktop right-click doesn't fire a navigating click either.
  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (e.currentTarget.getAttribute('data-state') === 'open') {
      e.preventDefault()
    }
    onClick?.(e)
  }

  return (
    <ContextMenuPrimitive.Trigger
      ref={ref}
      // Two iOS long-press gestures lift the element; we kill both (inline so it's
      // guaranteed on the rendered <a> regardless of asChild/Slot merging; all
      // iOS/WebKit-only properties + a no-op-on-desktop draggable flag):
      //  - the context-menu/link preview  → -webkit-touch-callout: none
      //  - the drag-and-drop lift (links are draggable by default) → draggable=
      //    false + -webkit-user-drag: none
      style={{ WebkitTouchCallout: 'none', WebkitUserDrag: 'none', ...style } as React.CSSProperties}
      draggable={false}
      className={cn(
        'touch:select-none touch:[-webkit-user-select:none]',
        'touch:transition-transform touch:duration-150 touch:ease-out touch:data-[pressing]:scale-[0.96]',
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      {...props}
    />
  )
})
ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName

const ContextMenuGroup = ContextMenuPrimitive.Group

const ContextMenuPortal = ContextMenuPrimitive.Portal

const ContextMenuSub = ContextMenuPrimitive.Sub

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
      inset && "pl-8",
      className
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </ContextMenuPrimitive.SubTrigger>
))
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-context-menu-content-transform-origin]",
      className
    )}
    {...props}
  />
))
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 max-h-[--radix-context-menu-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-context-menu-content-transform-origin]",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
))
ContextMenuCheckboxItem.displayName =
  ContextMenuPrimitive.CheckboxItem.displayName

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Circle className="h-4 w-4 fill-current" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
))
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-sm font-semibold text-foreground",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}
ContextMenuShortcut.displayName = "ContextMenuShortcut"

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
