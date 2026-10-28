import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { getPlatform } from '@renderer/lib/env'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

/*
 * Keyboard shortcuts for the Todo board, in the Linear style: single keys
 * with no modifier, acting on the selected (or hovered) card; J/K to step;
 * Esc to go back; "?" for the sheet. Keys never fire while typing, and never
 * with ⌘/Ctrl/Alt held, so the app's own shortcuts (⌘K, ⌘B, ⌘1–9…) are untouched.
 */

// Electron reports the platform; on the web, fall back to the browser's own.
const isMac = getPlatform() === 'darwin' || (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform))
export const MOD = isMac ? '⌘' : 'Ctrl'

/** True when a key press belongs to whatever the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Listen for board-style shortcuts on the window: plain keys only, not while
 * typing, not when something already handled the key.
 * The handler returns true when it used the key.
 */
export function usePlainKeys(handler: (event: KeyboardEvent) => boolean, enabled = true) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (handlerRef.current(event)) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

/** One key, drawn as a small chip. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/60 bg-muted px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/**
 * A tooltip that names the action and shows its keys, like Linear's: a light
 * popover card rather than the app's dark default, key chips on the right.
 */
export function ShortcutTooltip({ label, keys, side = 'bottom', children }: {
  label: string
  keys?: string[]
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          className="flex items-center gap-3 rounded-lg border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-md"
        >
          <span>{label}</span>
          {keys && keys.length > 0 && (
            <span className="flex items-center gap-1">
              {keys.map((k) => <Kbd key={k} className="bg-background">{k}</Kbd>)}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const GROUPS: { title: string; rows: { label: string; keys: string[][] }[] }[] = [
  {
    title: 'Board',
    rows: [
      { label: 'New draft', keys: [['C']] },
      { label: 'Move selection up / down', keys: [['K'], ['J']] },
      { label: 'Move between columns', keys: [['H'], ['L']] },
      { label: 'Arrow keys work too', keys: [['↑'], ['↓'], ['←'], ['→']] },
      { label: 'Open selected', keys: [['Enter']] },
      { label: 'Start draft', keys: [['S']] },
      { label: 'Mark done', keys: [['D']] },
      { label: 'Archive (a draft or done item)', keys: [['E']] },
      { label: 'Unarchive', keys: [['U']] },
      { label: 'Show or hide Done', keys: [['G', 'D']] },
      { label: 'Clear selection', keys: [['Esc']] },
    ],
  },
  {
    title: 'Session (started from the board)',
    rows: [
      { label: 'Next / previous that needs you', keys: [['J'], ['K']] },
      { label: 'Mark done', keys: [['D']] },
      { label: 'Archive (once done)', keys: [['E']] },
      { label: 'Back to board', keys: [['Esc']] },
    ],
  },
  {
    title: 'Draft',
    rows: [
      { label: 'Start', keys: [[MOD, 'Enter']] },
      { label: 'Close (keeps the draft)', keys: [['Esc']] },
    ],
  },
  {
    title: 'Anywhere here',
    rows: [{ label: 'Keyboard shortcuts', keys: [['?']] }],
  },
]

/** The "?" sheet: every shortcut, grouped by where it works. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0 sm:rounded-xl" data-testid="todo-shortcuts-dialog">
        <div className="border-b px-5 py-4">
          <DialogTitle className="text-sm font-medium">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
            Single keys act on the selected card. Hovering a card selects it.
          </DialogDescription>
        </div>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.title}</h3>
              <ul className="space-y-1.5">
                {group.rows.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-4 text-sm">
                    <span>{row.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {row.keys.map((combo, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-[11px] text-muted-foreground">or</span>}
                          {combo.map((k, j) => (
                            <span key={k} className="flex items-center gap-1">
                              {j > 0 && combo[0] === 'G' && <span className="text-[11px] text-muted-foreground">then</span>}
                              <Kbd>{k}</Kbd>
                            </span>
                          ))}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
