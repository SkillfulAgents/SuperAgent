import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { compileTrigger } from './hint-matchers'
import type { Hint, HintEventInput } from './hint-schema'

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
 * every matched hint as additional context; it never blocks.
 */
export function createHintsHook(hints: Hint[]): HookCallback {
  const compiled = hints.map((hint) => ({ hint, triggers: hint.triggers.map(compileTrigger) }))
  return async (input) => {
    const event = toHintEventInput(input)
    if (!event) return {}
    const matched = compiled
      .filter(({ triggers }) => triggers.some((matches) => matches(event)))
      .map(({ hint }) => hint.content)
    if (matched.length === 0) return {}
    return { hookSpecificOutput: { hookEventName: event.event, additionalContext: matched.join('\n\n') } }
  }
}
