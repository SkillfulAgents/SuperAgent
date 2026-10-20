import type { HintEvent, HintEventInput, HintTrigger } from './hint-schema'

export type HintMatcher = (input: HintEventInput) => boolean

/** Splits chained shell commands so `cd /app && sleep 5` tests `cd /app` and `sleep 5`. Not quote-aware. */
const COMMAND_SEPARATORS = /&&|\|\||[;|\n]/

/** Tools whose `Tool(pattern)` form is checked against this tool_input field. */
const TOOL_PATTERN_FIELDS: Record<string, string> = {
  Bash: 'command',
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `*` matches anything and spaces match any run of whitespace. A trailing ` *`
 * means "this word, then anything", so `ls *` matches `ls` and `ls -la` but not `lsof`.
 */
export function toolPatternToRegExp(pattern: string): RegExp {
  const wordThenAnything = pattern.endsWith(' *')
  const body = (wordThenAnything ? pattern.slice(0, -2) : pattern).trim()
  const source = body
    .split('*')
    .map((part) => part.split(/\s+/).map(escapeRegExp).join('\\s+'))
    .join('.*')
  return new RegExp(`^${source}${wordThenAnything ? '(?=$|[\\s;&|])' : '$'}`, 's')
}

export function parseToolMatch(match: string): { toolName: string; pattern?: string } {
  const parsed = /^([\w.-]+)(?:\((.+)\))?$/s.exec(match.trim())
  if (!parsed) throw new Error(`Invalid tool match "${match}"; expected Tool or Tool(pattern)`)
  return { toolName: parsed[1], pattern: parsed[2] }
}

function compileToolMatch(match: string): HintMatcher {
  const { toolName, pattern } = parseToolMatch(match)
  if (pattern === undefined) {
    return (input) => 'toolName' in input && input.toolName === toolName
  }
  const field = TOOL_PATTERN_FIELDS[toolName]
  if (!field) throw new Error(`Tool "${toolName}" does not support a (pattern) in "${match}"`)
  const regex = toolPatternToRegExp(pattern)
  return (input) => {
    if (!('toolName' in input) || input.toolName !== toolName) return false
    const value = (input.toolInput as Record<string, unknown> | undefined)?.[field]
    return typeof value === 'string' && value.split(COMMAND_SEPARATORS).some((part) => regex.test(part.trimStart()))
  }
}

function compilePromptMatch(match: string): HintMatcher {
  const regex = new RegExp(match, 'i')
  return (input) => 'prompt' in input && regex.test(input.prompt)
}

/** One matcher compiler per hook event. Adding an event touches more files; see builtin/README.md. */
const MATCHER_COMPILERS: Record<HintEvent, (match: string) => HintMatcher> = {
  UserPromptSubmit: compilePromptMatch,
  PreToolUse: compileToolMatch,
  PostToolUse: compileToolMatch,
}

export function compileTrigger(trigger: HintTrigger): HintMatcher {
  const matches = MATCHER_COMPILERS[trigger.event](trigger.match)
  return (input) => input.event === trigger.event && matches(input)
}
