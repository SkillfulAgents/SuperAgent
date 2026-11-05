import * as path from 'path'
import { loadHints } from './hint-loader'
import type { Hint } from './hint-schema'

/** Kill switch, like SESSION_PREWARM: BUILTIN_HINTS=0 (or false) turns built-in hints off. Read at start. */
export function builtinHintsEnabled(value = process.env.BUILTIN_HINTS): boolean {
  return !['0', 'false'].includes((value ?? '').trim().toLowerCase())
}

/** Whether a hint's `requires` is met. `platform` uses the same flag as the system prompt's platform sections. */
export function hintAvailable(hint: Hint, env: NodeJS.ProcessEnv = process.env): boolean {
  return hint.requires !== 'platform' || env.PLATFORM_AUTH_ACTIVE === 'true'
}

/** Every built-in hint, whatever its `requires`. Add new hints as `builtin/<topic>/<name>.md`. */
export const allBuiltinHints = loadHints(path.join(__dirname, 'builtin'))

/** The built-in hints this container runs. Read at start. */
export const builtinHints = builtinHintsEnabled() ? allBuiltinHints.filter((hint) => hintAvailable(hint)) : []
