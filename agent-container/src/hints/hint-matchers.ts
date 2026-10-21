import type { HintToolTrigger, HintTrigger } from './hint-schema'

/** One hook event, reduced to what triggers match on. */
export type HintEventInput =
  | { event: 'UserPromptSubmit'; prompt: string }
  | { event: 'PreToolUse' | 'PostToolUse'; toolName: string; toolInput: unknown }

export type HintMatcher = (input: HintEventInput) => boolean

/** Splits chained shell commands so `cd /app && sleep 5` tests `cd /app` and `sleep 5`. Not quote-aware. */
const COMMAND_SEPARATORS = /&&|\|\||[;|\n]/

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `*` matches anything and spaces match any run of whitespace. A trailing ` *`
 * means "this word, then anything", so `ls *` matches `ls` and `ls -la` but not `lsof`.
 * Matches the literal pieces in order with indexOf instead of a regex: a regex with
 * several `.*` backtracks for seconds on a long command that almost matches.
 */
export function compileGlob(glob: string): (value: string) => boolean {
  const wordThenAnything = glob.endsWith(' *')
  const pieces = collapseWhitespace((wordThenAnything ? glob.slice(0, -2) : glob).trim()).split('*')
  const first = pieces[0]
  const last = pieces[pieces.length - 1]
  const middle = pieces.slice(1, -1)
  const endsAt = (value: string, end: number) => !wordThenAnything || end === value.length || /[\s;&|]/.test(value[end])
  return (raw) => {
    const value = collapseWhitespace(raw)
    if (!value.startsWith(first)) return false
    if (pieces.length === 1) return wordThenAnything ? endsAt(value, first.length) : value === first
    let at = first.length
    for (const piece of middle) {
      const found = value.indexOf(piece, at)
      if (found < 0) return false
      at = found + piece.length
    }
    if (!wordThenAnything) return value.length - last.length >= at && value.endsWith(last)
    if (last === '') return true
    for (let found = value.indexOf(last, at); found >= 0; found = value.indexOf(last, found + 1)) {
      if (endsAt(value, found + last.length)) return true
    }
    return false
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** A Bash command is checked part by part; every other field as one value. */
function candidates(toolName: string, field: string, value: string): string[] {
  const parts = toolName === 'Bash' && field === 'command' ? value.split(COMMAND_SEPARATORS) : [value]
  return parts.map((part) => part.trimStart())
}

function compileToolTrigger(trigger: HintToolTrigger): HintMatcher {
  const fields = Object.entries(trigger.input ?? {}).map(([field, glob]) => [field, compileGlob(glob)] as const)
  return (input) => {
    if (!('toolName' in input) || input.toolName !== trigger.tool) return false
    const toolInput = (input.toolInput ?? {}) as Record<string, unknown>
    return fields.every(([field, matches]) => {
      const raw = toolInput[field]
      // Booleans and numbers compare as text, so `input: { run_in_background: "true" }` works.
      const value = typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : raw
      return typeof value === 'string' && candidates(trigger.tool, field, value).some((part) => matches(part))
    })
  }
}

function compilePromptTrigger(pattern: string): HintMatcher {
  const regex = new RegExp(pattern, 'i')
  return (input) => 'prompt' in input && regex.test(input.prompt)
}

/** One branch per hook event. Adding an event touches more files; see builtin/README.md. */
export function compileTrigger(trigger: HintTrigger): HintMatcher {
  const matches = trigger.event === 'UserPromptSubmit' ? compilePromptTrigger(trigger.prompt) : compileToolTrigger(trigger)
  return (input) => input.event === trigger.event && matches(input)
}
