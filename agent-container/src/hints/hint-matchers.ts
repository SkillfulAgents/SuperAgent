import type { HintEvent, HintEventInput, HintTrigger } from './hint-schema'

export type HintMatcher = (input: HintEventInput) => boolean

/** Tools whose `Tool(pattern)` form is checked against this tool_input field. */
const TOOL_PATTERN_FIELDS: Record<string, string> = {
  Bash: 'command',
}

function escapeRegExp(text: string): string {
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

function compileToolMatch(match: string): HintMatcher {
  const parsed = /^([\w.-]+)(?:\((.+)\))?$/s.exec(match.trim())
  if (!parsed) throw new Error(`Invalid tool match "${match}"; expected Tool or Tool(pattern)`)
  const [, toolName, pattern] = parsed
  if (pattern === undefined) {
    return (input) => 'toolName' in input && input.toolName === toolName
  }
  const field = TOOL_PATTERN_FIELDS[toolName]
  if (!field) throw new Error(`Tool "${toolName}" does not support a (pattern) in "${match}"`)
  const regex = toolPatternToRegExp(pattern)
  return (input) => {
    if (!('toolName' in input) || input.toolName !== toolName) return false
    const value = (input.toolInput as Record<string, unknown> | undefined)?.[field]
    return typeof value === 'string' && regex.test(value.trimStart())
  }
}

function compilePromptMatch(match: string): HintMatcher {
  const regex = new RegExp(match, 'i')
  return (input) => 'prompt' in input && regex.test(input.prompt)
}

/** One matcher compiler per hook event. A new event is one new entry here. */
const MATCHER_COMPILERS: Record<HintEvent, (match: string) => HintMatcher> = {
  UserPromptSubmit: compilePromptMatch,
  PreToolUse: compileToolMatch,
  PostToolUse: compileToolMatch,
}

export function compileTrigger(trigger: HintTrigger): HintMatcher {
  const matches = MATCHER_COMPILERS[trigger.event](trigger.match)
  return (input) => input.event === trigger.event && matches(input)
}
