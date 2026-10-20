export { createHintsHook } from './hints-hook'
export { loadHints, parseHint } from './hint-loader'
export type { Hint, HintEvent, HintTrigger } from './hint-schema'

import * as path from 'path'
import { loadHints } from './hint-loader'

/** All built-in hints. Add new hints as `builtin/<topic>/<name>.md`. */
export const builtinHints = loadHints(path.join(__dirname, 'builtin'))
