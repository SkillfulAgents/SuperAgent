import type { HintEventInput, HintToolTrigger, HintTrigger } from './hint-schema'

export type HintMatcher = (input: HintEventInput) => boolean

/** Splits chained shell commands so `cd /app && sleep 5` tests `cd /app` and `sleep 5`. Not quote-aware. */
const COMMAND_SEPARATORS = /&&|\|\||[;|\n]/

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `*` matches anything and spaces match any run of whitespace. A trailing ` *`
 * means "this word, then anything", so `ls *` matches `ls` and `ls -la` but not `lsof`.
 */
export function globToRegExp(glob: string): RegExp {
  const wordThenAnything = glob.endsWith(' *')
  const body = (wordThenAnything ? glob.slice(0, -2) : glob).trim()
  const source = body
    .split('*')
    .map((part) => part.split(/\s+/).map(escapeRegExp).join('\\s+'))
    .join('.*')
  return new RegExp(`^${source}${wordThenAnything ? '(?=$|[\\s;&|])' : '$'}`, 's')
}

/** A Bash command is checked part by part; every other field as one value. */
function candidates(toolName: string, field: string, value: string): string[] {
  const parts = toolName === 'Bash' && field === 'command' ? value.split(COMMAND_SEPARATORS) : [value]
  return parts.map((part) => part.trimStart())
}

function compileToolTrigger(trigger: HintToolTrigger): HintMatcher {
  const required = Object.entries(trigger.input ?? {}).map(([field, glob]) => [field, globToRegExp(glob)] as const)
  const excluded = Object.entries(trigger.unless ?? {}).map(([field, glob]) => [field, globToRegExp(glob)] as const)
  const fields = [...new Set([...required, ...excluded].map(([field]) => field))]
  return (input) => {
    if (!('toolName' in input) || input.toolName !== trigger.tool) return false
    const toolInput = (input.toolInput ?? {}) as Record<string, unknown>
    return fields.every((field) => {
      const want = required.find(([f]) => f === field)?.[1]
      const avoid = excluded.find(([f]) => f === field)?.[1]
      const value = toolInput[field]
      if (typeof value !== 'string') return !want
      return candidates(trigger.tool, field, value).some((part) => (!want || want.test(part)) && !avoid?.test(part))
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
