/**
 * Global keyboard-shortcut config shared by the Electron main process (which
 * registers the OS-level accelerator), the settings write boundary (which
 * validates it), and the renderer settings UI (which records it).
 *
 * This module is intentionally dependency-free (no `fs`/`electron`) so the
 * renderer can import it without pulling node-only modules into its bundle —
 * unlike settings.ts, which is type-only-safe for the renderer.
 */

/** Out-of-box default for the quick-dispatch launcher. ⌘⇧Space / Ctrl+Shift+Space. */
export const DEFAULT_GLOBAL_DISPATCH_SHORTCUT = 'CommandOrControl+Shift+Space'

// A loose Electron-accelerator validator: 2+ tokens (modifier(s) + key) joined
// by '+', each token alphanumeric (covers letters, digits, Space, F1-F24, Up,
// Plus-named keys). This only rejects obvious garbage at the settings boundary
// and in the UI — the authoritative gate is globalShortcut.register() in main,
// which is wrapped in try/catch and reports failure back to the renderer.
const ACCELERATOR_RE = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)+$/

/** True if `value` is plausibly a registerable accelerator (e.g. "CommandOrControl+Shift+Space"). */
export function isValidAccelerator(value: string): boolean {
  return value.length > 0 && value.length <= 64 && ACCELERATOR_RE.test(value)
}

// --- Accelerator <-> keyboard-event helpers (shared by the settings recorder) ---
//
// Kept here (not in the .tsx) so they stay dependency-free and unit-testable.
// The event shape is structural (a subset of the DOM KeyboardEvent) so this
// module never pulls in `lib.dom` for the main process that also imports it.

/** The subset of a keydown we need to derive an accelerator. */
export interface KeyComboEvent {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** `KeyboardEvent.code`, e.g. "KeyA", "Digit1", "Space", "ArrowUp". */
  code: string
}

/** Map a `KeyboardEvent.code` to the key token Electron accelerators use, or null if unsupported. */
export function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (code === 'Space') return 'Space'
  if (code === 'ArrowUp') return 'Up'
  if (code === 'ArrowDown') return 'Down'
  if (code === 'ArrowLeft') return 'Left'
  if (code === 'ArrowRight') return 'Right'
  if (code === 'Enter') return 'Return'
  return null
}

/**
 * Convert a keydown into an Electron accelerator, or null if it isn't a usable
 * combo. Requires at least one modifier plus a mappable key (a bare key would
 * be a global grab of a normal keystroke).
 */
export function eventToAccelerator(e: KeyComboEvent, platform: string): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = codeToKey(e.code)
  if (!key || mods.length === 0) return null
  return [...mods, key].join('+')
}

const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Super: '⌘',
}

/** Render an accelerator as friendly chips (⌘⇧Space on mac, Ctrl+Shift+Space elsewhere; "" → "Disabled"). */
export function formatAccelerator(accel: string, platform: string): string {
  if (!accel) return 'Disabled'
  const isMac = platform === 'darwin'
  const tokens = accel.split('+').map((tok) => {
    if (isMac && MAC_SYMBOLS[tok]) return MAC_SYMBOLS[tok]
    if (!isMac) {
      if (tok === 'CommandOrControl' || tok === 'Control') return 'Ctrl'
      if (tok === 'Super') return 'Win'
    }
    return tok
  })
  return tokens.join(isMac ? ' ' : '+')
}
