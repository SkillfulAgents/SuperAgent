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

  describe('deny', () => {
    const rmRoot = { event: 'PreToolUse', tool: 'Bash', input: { command: 'rm -rf /' } } as const
    const denied = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })

    it('refuses every matching call with repeat always', async () => {
      const hook = createHintsHook([{ ...hint('no-rm-root', 'Never delete the root folder.', [rmRoot], 'always'), deny: true }], () => 1)
      await expect(hook(bash('PreToolUse', 'rm -rf /'), 'tool-1', options)).resolves.toEqual(denied('Never delete the root folder.'))
      await expect(hook(bash('PreToolUse', 'rm -rf /'), 'tool-2', options)).resolves.toEqual(denied('Never delete the root folder.'))
      await expect(hook(bash('PreToolUse', 'ls'), 'tool-3', options)).resolves.toEqual({})
    })

    it('refuses the first matching call per user message with repeat turn, and lets the retry run', async () => {
      let turn = 1
      const hook = createHintsHook([{ ...hint('check-first', 'Check the target first.', [rmRoot], 'turn'), deny: true }], () => turn)
      await expect(hook(bash('PreToolUse', 'rm -rf /'), 'tool-1', options)).resolves.toEqual(denied('Check the target first.'))
      await expect(hook(bash('PreToolUse', 'rm -rf /'), 'tool-2', options)).resolves.toEqual({})
      turn = 2
      await expect(hook(bash('PreToolUse', 'rm -rf /'), 'tool-3', options)).resolves.toEqual(denied('Check the target first.'))
    })

    it('refuses only the first matching call per session with repeat once', async () => {
      let turn = 1
      const hints = [{ ...hint('check-first', 'Check the target first.', [rmRoot], 'once'), deny: true }]
      const sessionA = createHintsHook(hints, () => turn)
      const sessionB = createHintsHook(hints, () => turn)
      await expect(sessionA(bash('PreToolUse', 'rm -rf /'), 'tool-1', options)).resolves.toEqual(denied('Check the target first.'))
      turn = 2
      await expect(sessionA(bash('PreToolUse', 'rm -rf /'), 'tool-2', options)).resolves.toEqual({})
      await expect(sessionB(bash('PreToolUse', 'rm -rf /'), 'tool-1', options)).resolves.toEqual(denied('Check the target first.'))
    })

    it('puts every hint that fires in the reason', async () => {
      const hook = createHintsHook([
        { ...hint('no-rm-root', 'Never delete the root folder.', [rmRoot]), deny: true },
        hint('any-bash', 'Plain hint.', [{ event: 'PreToolUse', tool: 'Bash' }]),
      ], () => 1)
      await expect(hook(bash('PreToolUse', 'rm -rf /'), 'tool-1', options)).resolves.toEqual(denied('Never delete the root folder.\n\nPlain hint.'))
      await expect(hook(bash('PreToolUse', 'ls'), 'tool-2', options)).resolves.toEqual(shown('Plain hint.'))
    })
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
