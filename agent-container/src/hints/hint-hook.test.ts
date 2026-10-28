import { describe, it, expect } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createHintHookMatchers, createHintsHook } from './hint-hook'
import type { Hint } from './hint-schema'

const options = { signal: new AbortController().signal }

function bash(event: 'PreToolUse' | 'PostToolUse', command: unknown): HookInput {
  return { hook_event_name: event, tool_name: 'Bash', tool_input: { command } } as HookInput
}

function shown(additionalContext: string) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }
}

function hint(name: string, content: string, triggers: Hint['triggers'], repeat: Hint['repeat'] = 'always'): Hint {
  return { name, description: `${name} hint`, content, triggers, repeat }
}

describe('createHintsHook', () => {
  const hook = createHintsHook([
    hint('a', 'First', [{ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *' } }, { event: 'PreToolUse', tool: 'Bash' }]),
    hint('b', 'Second', [{ event: 'PreToolUse', tool: 'Bash' }]),
    hint('c', 'Third', [{ event: 'PostToolUse', tool: 'Bash' }]),
  ], () => 1)

  it('adds every matched hint once, even when several triggers match', async () => {
    await expect(hook(bash('PreToolUse', 'sleep 300'), 'tool-1', options)).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'First\n\nSecond' },
    })
    await expect(hook(bash('PostToolUse', 'ls'), 'tool-1', options)).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Third' },
    })
  })

  it('shows a once hint only the first time it matches, per hook', async () => {
    const hints = [hint('sleep', 'No sleep', [{ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *' } }], 'once')]
    let turn = 1
    const sessionA = createHintsHook(hints, () => turn)
    const sessionB = createHintsHook(hints, () => turn)
    await expect(sessionA(bash('PreToolUse', 'sleep 30'), 'tool-1', options)).resolves.toEqual(shown('No sleep'))
    await expect(sessionA(bash('PreToolUse', 'sleep 30'), 'tool-2', options)).resolves.toEqual({})
    turn = 2
    await expect(sessionA(bash('PreToolUse', 'sleep 30'), 'tool-3', options)).resolves.toEqual({})
    await expect(sessionB(bash('PreToolUse', 'sleep 30'), 'tool-1', options)).resolves.toEqual(shown('No sleep'))
  })

  it('shows a turn hint once per user message', async () => {
    let turn = 1
    const hook = createHintsHook([hint('sleep', 'No sleep', [{ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *' } }], 'turn')], () => turn)
    await expect(hook(bash('PreToolUse', 'sleep 30'), 'tool-1', options)).resolves.toEqual(shown('No sleep'))
    await expect(hook(bash('PreToolUse', 'sleep 30'), 'tool-2', options)).resolves.toEqual({})
    turn = 2
    await expect(hook(bash('PreToolUse', 'sleep 30'), 'tool-3', options)).resolves.toEqual(shown('No sleep'))
    await expect(hook(bash('PreToolUse', 'sleep 30'), 'tool-4', options)).resolves.toEqual({})
  })

  it('returns nothing when no hint matches', async () => {
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as HookInput
    await expect(hook(read, 'tool-1', options)).resolves.toEqual({})
  })
})

describe('createHintHookMatchers', () => {
  it('registers nothing when there are no hints', () => {
    expect(createHintHookMatchers([], () => 1)).toEqual({ UserPromptSubmit: [], PreToolUse: [], PostToolUse: [] })
  })

  it('limits each tool event to the exact tools its hints name', () => {
    const matchers = createHintHookMatchers([
      hint('a', 'First', [{ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *' } }, { event: 'PreToolUse', tool: 'Bash' }]),
      hint('b', 'Second', [{ event: 'PreToolUse', tool: 'mcp__slack__send_message' }]),
    ], () => 1)
    expect(matchers.UserPromptSubmit).toEqual([])
    expect(matchers.PostToolUse).toEqual([])
    expect(matchers.PreToolUse).toHaveLength(1)
    const regex = new RegExp(matchers.PreToolUse[0].matcher!)
    expect(['Bash', 'mcp__slack__send_message'].every((name) => regex.test(name))).toBe(true)
    expect(['BashOutput', 'Read', 'mcp__slack__send_messages'].some((name) => regex.test(name))).toBe(false)
  })

  it('registers UserPromptSubmit without a matcher when a hint uses it', () => {
    const matchers = createHintHookMatchers([hint('a', 'First', [{ event: 'UserPromptSubmit', prompt: 'deploy' }])], () => 1)
    expect(matchers.UserPromptSubmit).toHaveLength(1)
    expect(matchers.UserPromptSubmit[0].matcher).toBeUndefined()
  })
})
