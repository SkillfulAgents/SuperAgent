import type { HookCallback, HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { compileTrigger, escapeRegExp, parseToolMatch } from './hint-matchers'
import type { Hint, HintEvent, HintEventInput } from './hint-schema'

function toHintEventInput(input: HookInput): HintEventInput | undefined {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return { event: input.hook_event_name, prompt: input.prompt }
    case 'PreToolUse':
    case 'PostToolUse':
      return { event: input.hook_event_name, toolName: input.tool_name, toolInput: input.tool_input }
    default:
      return undefined
  }
}

/**
 * One hook for UserPromptSubmit, PreToolUse and PostToolUse. Adds the body of
 * every matched hint as additional context; it never blocks. Each hook keeps
 * its own record of shown hints, so create one per session. `currentTurn`
 * returns the session's user-message count.
 */
export function createHintsHook(hints: Hint[], currentTurn: () => number): HookCallback {
  const compiled = hints.map((hint) => ({ hint, triggers: hint.triggers.map(compileTrigger) }))
  const lastShownTurn = new Map<string, number>()
  const canShow = (hint: Hint, turn: number): boolean => {
    if (hint.repeat === 'always' || !lastShownTurn.has(hint.name)) return true
    return hint.repeat === 'turn' && lastShownTurn.get(hint.name) !== turn
  }
  return async (input) => {
    const event = toHintEventInput(input)
    if (!event) return {}
    const turn = currentTurn()
    const matched = compiled
      .filter(({ hint }) => canShow(hint, turn))
      .filter(({ triggers }) => triggers.some((matches) => matches(event)))
      .map(({ hint }) => hint)
    if (matched.length === 0) return {}
    for (const hint of matched) lastShownTurn.set(hint.name, turn)
    return {
      hookSpecificOutput: { hookEventName: event.event, additionalContext: matched.map((hint) => hint.content).join('\n\n') },
    }
  }
}

/**
 * SDK hook entries per event. A tool event only gets an entry whose matcher
 * lists the tools some hint names, so other tool calls skip the callback.
 */
export function createHintHookMatchers(hints: Hint[], currentTurn: () => number): Record<HintEvent, HookCallbackMatcher[]> {
  const hook = createHintsHook(hints, currentTurn)
  const triggers = hints.flatMap((hint) => hint.triggers)
  const forTools = (event: 'PreToolUse' | 'PostToolUse'): HookCallbackMatcher[] => {
    const toolNames = [...new Set(triggers.filter((t) => t.event === event).map((t) => parseToolMatch(t.match).toolName))]
    if (toolNames.length === 0) return []
    return [{ matcher: `^(${toolNames.map(escapeRegExp).join('|')})$`, hooks: [hook] }]
  }
  return {
    UserPromptSubmit: triggers.some((t) => t.event === 'UserPromptSubmit') ? [{ hooks: [hook] }] : [],
    PreToolUse: forTools('PreToolUse'),
    PostToolUse: forTools('PostToolUse'),
  }
}
