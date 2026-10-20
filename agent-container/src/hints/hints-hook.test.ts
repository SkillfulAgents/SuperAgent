import { describe, it, expect } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createHintHookMatchers, createHintsHook } from './hints-hook'
import { builtinHints, builtinHintsEnabled } from './index'
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
    hint('a', 'First', [{ event: 'PreToolUse', match: 'Bash(sleep *)' }, { event: 'PreToolUse', match: 'Bash' }]),
    hint('b', 'Second', [{ event: 'PreToolUse', match: 'Bash' }]),
    hint('c', 'Third', [{ event: 'PostToolUse', match: 'Bash' }]),
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
    const hints = [hint('sleep', 'No sleep', [{ event: 'PreToolUse', match: 'Bash(sleep *)' }], 'once')]
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
    const hook = createHintsHook([hint('sleep', 'No sleep', [{ event: 'PreToolUse', match: 'Bash(sleep *)' }], 'turn')], () => turn)
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
      hint('a', 'First', [{ event: 'PreToolUse', match: 'Bash(sleep *)' }, { event: 'PreToolUse', match: 'Bash' }]),
      hint('b', 'Second', [{ event: 'PreToolUse', match: 'mcp__slack__send_message' }]),
    ], () => 1)
    expect(matchers.UserPromptSubmit).toEqual([])
    expect(matchers.PostToolUse).toEqual([])
    expect(matchers.PreToolUse).toHaveLength(1)
    const regex = new RegExp(matchers.PreToolUse[0].matcher!)
    expect(['Bash', 'mcp__slack__send_message'].every((name) => regex.test(name))).toBe(true)
    expect(['BashOutput', 'Read', 'mcp__slack__send_messages'].some((name) => regex.test(name))).toBe(false)
  })

  it('registers UserPromptSubmit without a matcher when a hint uses it', () => {
    const matchers = createHintHookMatchers([hint('a', 'First', [{ event: 'UserPromptSubmit', match: 'deploy' }])], () => 1)
    expect(matchers.UserPromptSubmit).toHaveLength(1)
    expect(matchers.UserPromptSubmit[0].matcher).toBeUndefined()
  })
})

describe('built-in hints', () => {
  it('all compile', () => {
    expect(() => createHintHookMatchers(builtinHints, () => 1)).not.toThrow()
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

describe('built-in hint triggers', () => {
  const context = async (input: HookInput) => {
    const result = await createHintsHook(builtinHints, () => 1)(input, 'tool-1', options)
    return (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext
  }
  const fileTool = (event: 'PostToolUse', tool: string, file_path: string) =>
    ({ hook_event_name: event, tool_name: tool, tool_input: { file_path } }) as HookInput

  it.each([
    'agent-browser open https://example.com',
    '  agent-browser snapshot',
    'which agent-browser',
    '\twhich   agent-browser; agent-browser --help',
  ])('agent-browser-bash warns without denying: %s', async (command) => {
    expect(await context(bash('PreToolUse', command))).toContain('STRONG WARNING')
  })

  it.each([
    'echo agent-browser',
    'env | grep -i browser',
    'which agent-browser-helper',
    'agent-browser-helper open https://example.com',
    '',
    undefined,
  ])('agent-browser-bash ignores %s', async (command) => {
    expect(await context(bash('PreToolUse', command))).toBeUndefined()
  })

  it('agent-browser-bash warns on every call, like the hook it replaced', async () => {
    const hook = createHintsHook(builtinHints, () => 1)
    for (const id of ['tool-1', 'tool-2']) {
      const result = await hook(bash('PreToolUse', 'agent-browser snapshot'), id, options)
      expect(JSON.stringify(result)).toContain('STRONG WARNING')
    }
  })

  it('update-skill-md follows a write or edit inside a skill', async () => {
    expect(await context(fileTool('PostToolUse', 'Write', '/workspace/.claude/skills/fetch-weather/weather.py'))).toContain('SKILL.md')
    expect(await context(fileTool('PostToolUse', 'Edit', '/workspace/.claude/skills/fetch-weather/SKILL.md'))).toContain('SKILL.md')
    expect(await context(fileTool('PostToolUse', 'Write', '/workspace/reports/weather.py'))).toBeUndefined()
  })

  it('uv-run-env-file reminds before uv run, including chained commands', async () => {
    expect(await context(bash('PreToolUse', 'uv run --with requests fetch.py'))).toContain('--env-file .env')
    expect(await context(bash('PreToolUse', 'cd /workspace && uv run fetch.py'))).toContain('--env-file .env')
    expect(await context(bash('PreToolUse', 'uvx ruff check'))).toBeUndefined()
  })
})
