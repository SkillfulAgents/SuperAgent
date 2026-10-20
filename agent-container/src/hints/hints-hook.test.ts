import { describe, it, expect } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createHintHookMatchers, createHintsHook } from './hints-hook'
import { builtinHints, builtinHintsEnabled } from './index'
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

describe('createHintHookMatchers', () => {
  it('registers nothing when there are no hints', () => {
    expect(createHintHookMatchers([])).toEqual({ UserPromptSubmit: [], PreToolUse: [], PostToolUse: [] })
  })

  it('limits each tool event to the exact tools its hints name', () => {
    const matchers = createHintHookMatchers([
      hint('a', 'First', [{ event: 'PreToolUse', match: 'Bash(sleep *)' }, { event: 'PreToolUse', match: 'Bash' }]),
      hint('b', 'Second', [{ event: 'PreToolUse', match: 'mcp__slack__send_message' }]),
    ])
    expect(matchers.UserPromptSubmit).toEqual([])
    expect(matchers.PostToolUse).toEqual([])
    expect(matchers.PreToolUse).toHaveLength(1)
    const regex = new RegExp(matchers.PreToolUse[0].matcher!)
    expect(['Bash', 'mcp__slack__send_message'].every((name) => regex.test(name))).toBe(true)
    expect(['BashOutput', 'Read', 'mcp__slack__send_messages'].some((name) => regex.test(name))).toBe(false)
  })

  it('registers UserPromptSubmit without a matcher when a hint uses it', () => {
    const matchers = createHintHookMatchers([hint('a', 'First', [{ event: 'UserPromptSubmit', match: 'deploy' }])])
    expect(matchers.UserPromptSubmit).toHaveLength(1)
    expect(matchers.UserPromptSubmit[0].matcher).toBeUndefined()
  })
})

describe('built-in hints', () => {
  it('all compile', () => {
    expect(() => createHintHookMatchers(builtinHints)).not.toThrow()
  })

  it.each([
    [undefined, true],
    ['', true],
    ['1', true],
    ['0', false],
    [' FALSE ', false],
  ])('BUILTIN_HINTS=%s → enabled %s', (value, expected) => {
    expect(builtinHintsEnabled(value)).toBe(expected)
  })
})
