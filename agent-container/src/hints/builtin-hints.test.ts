import { describe, it, expect } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { builtinHints } from './index'
import { compileTrigger } from './hint-matchers'
import { createHintsHook } from './hints-hook'
import type { HintEventInput } from './hint-schema'

const compiled = builtinHints.map((hint) => ({ name: hint.name, triggers: hint.triggers.map(compileTrigger) }))
const matching = (input: HintEventInput) => compiled.filter(({ triggers }) => triggers.some((m) => m(input))).map(({ name }) => name).sort()

const bash = (command: string): HintEventInput => ({ event: 'PreToolUse', toolName: 'Bash', toolInput: { command } })
const wrote = (file_path: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Write', toolInput: { file_path } })
const edited = (file_path: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Edit', toolInput: { file_path } })

// Every row lists the exact hints a call triggers. A new hint that also fires on another hint's example
// fails here, so its author decides whether both should fire.
const CASES: Array<[string, HintEventInput, string[]]> = [
  ['agent-browser command', bash('agent-browser open https://example.com'), ['agent-browser-bash']],
  ['agent-browser lookup', bash('which agent-browser'), ['agent-browser-bash']],
  ['agent-browser after leading spaces', bash('  agent-browser snapshot'), ['agent-browser-bash']],
  ['agent-browser lookup then help', bash('\twhich   agent-browser; agent-browser --help'), ['agent-browser-bash']],
  ['echo agent-browser', bash('echo agent-browser'), []],
  ['grep env for browser', bash('env | grep -i browser'), []],
  ['similar tool name', bash('which agent-browser-helper'), []],
  ['similar command name', bash('agent-browser-helper open https://example.com'), []],
  ['empty command', bash(''), []],
  ['uv run without env file', bash('uv run --with requests fetch.py'), ['uv-run-env-file']],
  ['uv run after cd', bash('cd /workspace && uv run fetch.py'), ['uv-run-env-file']],
  ['uvx', bash('uvx ruff check'), []],
  ['uv run with env file', bash('uv run --env-file .env --with requests fetch.py'), []],
  ['write a skill script', wrote('/workspace/.claude/skills/fetch-weather/weather.py'), ['update-skill-md']],
  ['edit a skill script', edited('/workspace/.claude/skills/fetch-weather/weather.py'), ['update-skill-md']],
  ['write outside skills', wrote('/workspace/reports/weather.py'), []],
  ['edit SKILL.md itself', edited('/workspace/.claude/skills/fetch-weather/SKILL.md'), []],
  ['agent-browser and uv run in one command', bash('agent-browser snapshot && uv run report.py'), ['agent-browser-bash', 'uv-run-env-file']],
]

describe('built-in hints: which hints each call triggers', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(matching(input)).toEqual(expected)
  })

  it('every built-in hint has at least one example here', () => {
    const covered = new Set(CASES.flatMap(([, , names]) => names))
    expect(builtinHints.map((h) => h.name).filter((name) => !covered.has(name))).toEqual([])
  })

  it('agent-browser-bash warns on every call, like the hook it replaced', async () => {
    const hook = createHintsHook(builtinHints, () => 1)
    const call = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'agent-browser snapshot' } } as HookInput
    for (const id of ['tool-1', 'tool-2']) {
      expect(JSON.stringify(await hook(call, id, { signal: new AbortController().signal }))).toContain('STRONG WARNING')
    }
  })
})
