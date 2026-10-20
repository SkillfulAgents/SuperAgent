import { describe, it, expect } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createHintsHook } from './hints-hook'
import { builtinHints } from './index'
import type { Hint } from './hint-schema'

const options = { signal: new AbortController().signal }

function bash(event: 'PreToolUse' | 'PostToolUse', command: unknown): HookInput {
  return { hook_event_name: event, tool_name: 'Bash', tool_input: { command } } as HookInput
}

function hint(name: string, content: string, triggers: Hint['triggers']): Hint {
  return { name, description: `${name} hint`, content, triggers }
}

describe('createHintsHook', () => {
  const hook = createHintsHook([
    hint('a', 'First', [{ event: 'PreToolUse', match: 'Bash(sleep *)' }, { event: 'PreToolUse', match: 'Bash' }]),
    hint('b', 'Second', [{ event: 'PreToolUse', match: 'Bash' }]),
    hint('c', 'Third', [{ event: 'PostToolUse', match: 'Bash' }]),
  ])

  it('adds every matched hint once, even when several triggers match', async () => {
    await expect(hook(bash('PreToolUse', 'sleep 300'), 'tool-1', options)).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'First\n\nSecond' },
    })
    await expect(hook(bash('PostToolUse', 'ls'), 'tool-1', options)).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Third' },
    })
  })

  it('returns nothing when no hint matches', async () => {
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as HookInput
    await expect(hook(read, 'tool-1', options)).resolves.toEqual({})
  })
})

describe('built-in hints', () => {
  it('all compile', () => {
    expect(() => createHintsHook(builtinHints)).not.toThrow()
  })
})
