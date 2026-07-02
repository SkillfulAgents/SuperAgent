import { globalShortcut } from 'electron'
import { DEFAULT_GLOBAL_DISPATCH_SHORTCUT, isValidAccelerator } from '@shared/lib/config/shortcuts'

// Owns the single OS-global accelerator that opens the quick-dispatch launcher.
// Extracted from index.ts so the register/unregister/validate branching can be
// unit-tested without booting the whole main process. The trigger callback is
// injected (rather than imported) to keep this module free of window deps.

export interface ShortcutRegistrationResult {
  success: boolean
  error?: string
}

// The currently-registered accelerator, so a change can unregister the old
// binding before registering the new one (otherwise old shortcuts leak).
let currentDispatchShortcut: string | null = null

/** Unregister the current quick-dispatch accelerator (if any) and clear state. */
export function unregisterGlobalDispatchShortcut(): void {
  if (currentDispatchShortcut) {
    globalShortcut.unregister(currentDispatchShortcut)
    currentDispatchShortcut = null
  }
}

/**
 * Register (or re-register) the OS-global quick-dispatch accelerator, calling
 * `onTrigger` when it fires. `undefined` falls back to the default; `''` leaves
 * the launcher disabled. Returns a result so the settings UI can surface a
 * "shortcut already in use" conflict instead of silently failing.
 */
export function registerGlobalDispatchShortcut(
  accelerator: string | undefined,
  onTrigger: () => void,
): ShortcutRegistrationResult {
  // Always release the previous binding first.
  unregisterGlobalDispatchShortcut()

  const accel = accelerator ?? DEFAULT_GLOBAL_DISPATCH_SHORTCUT
  if (accel === '') return { success: true } // disabled
  if (!isValidAccelerator(accel)) {
    return { success: false, error: "That shortcut isn't a valid key combination." }
  }

  try {
    const ok = globalShortcut.register(accel, onTrigger)
    if (!ok) {
      return { success: false, error: 'That shortcut is already in use by another app.' }
    }
    currentDispatchShortcut = accel
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to register the shortcut.',
    }
  }
}
