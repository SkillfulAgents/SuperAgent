export { createHintHookMatchers, createHintsHook } from './hints-hook'
export { loadHints, parseHint } from './hint-loader'
export type { Hint, HintEvent, HintTrigger } from './hint-schema'

import * as path from 'path'
import { loadHints } from './hint-loader'

/** Kill switch, like SESSION_PREWARM: BUILTIN_HINTS=0 (or false) turns built-in hints off. Read at start. */
export function builtinHintsEnabled(value = process.env.BUILTIN_HINTS): boolean {
  return !['0', 'false'].includes((value ?? '').trim().toLowerCase())
}

/** All built-in hints. Add new hints as `builtin/<topic>/<name>.md`. */
export const builtinHints = builtinHintsEnabled() ? loadHints(path.join(__dirname, 'builtin')) : []
