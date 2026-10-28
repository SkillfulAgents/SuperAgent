import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@shared/lib/utils/cn'
import { getPlatform } from '@renderer/lib/env'

/**
 * Hold-to-hint sidebar navigation: holding the primary modifier (⌘ on macOS,
 * Ctrl elsewhere) past HOLD_THRESHOLD_MS overlays numbered badges on the first
 * nine registered nav targets — agent rows plus an expanded agent's visible
 * dashboard/session rows, numbered in document order. Pressing modifier+digit
 * activates the matching target. The digit shortcut works immediately; the
 * hold threshold only gates the visual overlay.
 *
 * Targets self-register via useCmdHintTarget, so the numbering always tracks
 * exactly what the sidebar currently renders (collapsed agents contribute no
 * sub-rows, the sessions list contributes only its visible slice).
 */
const HOLD_THRESHOLD_MS = 450
const MAX_HINTS = 9

interface RegisteredTarget {
  getElement: () => HTMLElement | null
}

interface CmdHintContextValue {
  register: (id: string, target: RegisteredTarget) => () => void
  /** id -> 1..9 while the hint overlay is visible, null otherwise. */
  assignments: ReadonlyMap<string, number> | null
}

// Default value (rather than a throwing hook) so sidebar rows render unchanged
// in unit tests and any tree without the provider.
const CmdHintContext = createContext<CmdHintContextValue>({
  register: () => () => {},
  assignments: null,
})

function digitFromEvent(e: KeyboardEvent): number | null {
  const fromCode = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1]
  const digit = fromCode ?? (/^[1-9]$/.test(e.key) ? e.key : null)
  return digit ? Number(digit) : null
}

export function CmdHintProvider({ children }: { children: ReactNode }) {
  const targetsRef = useRef(new Map<string, RegisteredTarget>())
  const [assignments, setAssignments] = useState<ReadonlyMap<string, number> | null>(null)
  const assignmentsRef = useRef(assignments)
  assignmentsRef.current = assignments

  const register = useCallback((id: string, target: RegisteredTarget) => {
    targetsRef.current.set(id, target)
    return () => {
      targetsRef.current.delete(id)
    }
  }, [])

  useEffect(() => {
    let holdTimer: number | null = null

    // Registration order is render order, not document order (an agent
    // expanded later re-registers its sub-rows after its siblings), so sort by
    // DOM position and drop anything unmounted or hidden.
    const orderedTargets = () => {
      const entries: Array<{ id: string; element: HTMLElement }> = []
      for (const [id, target] of targetsRef.current) {
        const element = target.getElement()
        if (element?.isConnected && element.getClientRects().length > 0) {
          entries.push({ id, element })
        }
      }
      entries.sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      return entries.slice(0, MAX_HINTS)
    }

    const showHints = () => {
      const next = new Map<string, number>()
      orderedTargets().forEach(({ id }, index) => next.set(id, index + 1))
      setAssignments(next)
    }

    const hideHints = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer)
        holdTimer = null
      }
      if (assignmentsRef.current) setAssignments(null)
    }

    // Electron knows its platform; the web build doesn't, so accept either
    // modifier there (⌘-digit is browser tab switching in most browsers, but
    // Ctrl-digit still reaches the page).
    const platform = getPlatform()
    const usesMeta = platform ? platform === 'darwin' : undefined
    const isPrimaryModifierKey = (e: KeyboardEvent) =>
      usesMeta === undefined
        ? e.key === 'Meta' || e.key === 'Control'
        : e.key === (usesMeta ? 'Meta' : 'Control')
    const hasPrimaryModifier = (e: KeyboardEvent) =>
      usesMeta === undefined ? e.metaKey || e.ctrlKey : usesMeta ? e.metaKey : e.ctrlKey

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isPrimaryModifierKey(e)) {
        if (e.repeat || e.shiftKey || e.altKey) return
        if (holdTimer === null && !assignmentsRef.current) {
          holdTimer = window.setTimeout(() => {
            holdTimer = null
            showHints()
          }, HOLD_THRESHOLD_MS)
        }
        return
      }

      const digit =
        hasPrimaryModifier(e) && !e.shiftKey && !e.altKey ? digitFromEvent(e) : null
      if (digit !== null) {
        // While the overlay is up, honor the numbers the user is looking at
        // (they're frozen at reveal time even if rows appear underneath);
        // on a quick press with no overlay, resolve against the live order.
        let targetId: string | undefined
        if (assignmentsRef.current) {
          for (const [id, assigned] of assignmentsRef.current) {
            if (assigned === digit) {
              targetId = id
              break
            }
          }
        } else {
          targetId = orderedTargets()[digit - 1]?.id
        }
        const element = targetId ? targetsRef.current.get(targetId)?.getElement() : null
        if (element) {
          e.preventDefault()
          // The row's own link owns the navigation (route, params, active
          // styling) — a synthetic click keeps a single source of truth.
          element.click()
        }
        return
      }

      // Any other key while the modifier is down is a different shortcut
      // (⌘K, ⌘C, ...) — cancel the pending reveal / dismiss the overlay.
      hideHints()
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isPrimaryModifierKey(e)) hideHints()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', hideHints)
    return () => {
      if (holdTimer !== null) window.clearTimeout(holdTimer)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', hideHints)
    }
  }, [])

  const value = useMemo(() => ({ register, assignments }), [register, assignments])

  return <CmdHintContext.Provider value={value}>{children}</CmdHintContext.Provider>
}

/**
 * Register the calling row as a hint navigation target. Attach `ref` to the
 * row's link element; `hint` is the row's 1..9 badge number while the overlay
 * is visible, null otherwise.
 */
export function useCmdHintTarget(): {
  ref: (element: HTMLElement | null) => void
  hint: number | null
} {
  const { register, assignments } = useContext(CmdHintContext)
  const id = useId()
  const elementRef = useRef<HTMLElement | null>(null)
  const ref = useCallback((element: HTMLElement | null) => {
    elementRef.current = element
  }, [])

  useEffect(
    () => register(id, { getElement: () => elementRef.current }),
    [register, id]
  )

  return { ref, hint: assignments?.get(id) ?? null }
}

export function CmdHintBadge({ hint, className }: { hint: number; className?: string }) {
  const platform = getPlatform()
  const isMac = platform ? platform === 'darwin' : /Mac/i.test(navigator.platform)
  return (
    <kbd
      data-testid={`cmd-hint-${hint}`}
      className={cn(
        'pointer-events-none inline-flex h-4 shrink-0 items-center rounded bg-foreground/[0.08] px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground',
        className
      )}
    >
      {isMac ? `⌘${hint}` : `Ctrl+${hint}`}
    </kbd>
  )
}
