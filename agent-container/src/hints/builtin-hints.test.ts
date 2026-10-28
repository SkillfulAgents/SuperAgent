import { describe, it, expect } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { builtinHints, builtinHintsEnabled } from './builtin-hints'
import { createHintHookMatchers, createHintsHook } from './hint-hook'
import { compileTrigger, type HintEventInput } from './hint-matchers'

const compiled = builtinHints.map((hint) => ({ name: hint.name, triggers: hint.triggers.map(compileTrigger) }))
const matching = (input: HintEventInput) => compiled.filter(({ triggers }) => triggers.some((m) => m(input))).map(({ name }) => name).sort()

const bash = (command: string): HintEventInput => ({ event: 'PreToolUse', toolName: 'Bash', toolInput: { command } })
const read = (file_path: string): HintEventInput => ({ event: 'PreToolUse', toolName: 'Read', toolInput: { file_path } })
const wrote = (file_path: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Write', toolInput: { file_path } })
const edited = (file_path: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Edit', toolInput: { file_path } })
const before = (toolName: string, toolInput: Record<string, unknown> = {}): HintEventInput => ({ event: 'PreToolUse', toolName, toolInput })
const after = (toolName: string, toolInput: Record<string, unknown> = {}): HintEventInput => ({ event: 'PostToolUse', toolName, toolInput })

// Every row lists the exact hints a call triggers. A new hint that also fires on another hint's example
// fails here, so its author decides whether both should fire.
const CASES: Array<[string, HintEventInput, string[]]> = [
  ['agent-browser command', bash('agent-browser open https://example.com'), ['agent-browser-bash']],
  ['agent-browser lookup', bash('which agent-browser'), ['agent-browser-bash']],
  ['agent-browser after leading spaces', bash('  agent-browser snapshot'), ['agent-browser-bash']],
  ['agent-browser lookup then help', bash('\twhich   agent-browser; agent-browser --help'), ['agent-browser-bash']],
  ['echo agent-browser', bash('echo agent-browser'), []],
  ['grep env for browser', bash('env | grep -i browser'), ['no-secret-values']],
  ['similar tool name', bash('which agent-browser-helper'), []],
  ['similar command name', bash('agent-browser-helper open https://example.com'), []],
  ['empty command', bash(''), []],
  ['uv run without env file', bash('uv run --with requests fetch.py'), ['uv-run-env-file']],
  ['uv run after cd', bash('cd /workspace && uv run fetch.py'), ['uv-run-env-file']],
  ['uvx', bash('uvx ruff check'), []],
  ['uv run with env file (reminder still shows)', bash('uv run --env-file .env --with requests fetch.py'), ['uv-run-env-file']],
  ['write a skill script', wrote('/workspace/.claude/skills/fetch-weather/weather.py'), ['update-skill-md']],
  ['edit a skill script', edited('/workspace/.claude/skills/fetch-weather/weather.py'), ['update-skill-md']],
  ['write outside skills', wrote('/workspace/reports/weather.py'), []],
  ['edit SKILL.md itself', edited('/workspace/.claude/skills/fetch-weather/SKILL.md'), ['update-skill-md']],
  ['print the env file', bash('cat /workspace/.env'), ['no-secret-values']],
  ['grep the environment', bash('env | grep -i crm'), ['no-secret-values']],
  ['printenv', bash('printenv CRM_API_KEY'), ['no-secret-values']],
  ['read the env file', read('/workspace/.env'), ['no-secret-values']],
  ['read a normal file', read('/workspace/notes/plan.md'), []],
  ['category is not cat', bash('category=reports; ls $category'), []],
  ['agent-browser and uv run in one command', bash('agent-browser snapshot && uv run report.py'), ['agent-browser-bash', 'uv-run-env-file']],
  ['inspect webhook events', before('mcp__user-input__inspect_webhook_events', { trigger_id: 'wt_lunch1' }), ['inspect-webhook-events']],
  ['list triggers', before('mcp__user-input__list_triggers'), []],
  ['supabase SQL', before('mcp__supabase__execute_sql', { project_id: 'abc', query: 'select id from public.orders limit 5' }), ['supabase-check-columns']],
  ['supabase list tables', before('mcp__supabase__list_tables', { project_id: 'abc' }), []],
  ['after a sign-in step', after('mcp__user-input__request_login', { message: 'Sign in to MockMail.', fields: [] }), ['sign-in-verify-way']],
  ['before a sign-in step', before('mcp__user-input__request_login', { message: 'Sign in to MockMail.' }), []],
  ['browser hand-over', before('mcp__user-input__request_browser_input', { message: 'Solve the CAPTCHA.' }), []],
  ['run faster-whisper with uv', bash('cd /tmp/review && uv run --with faster-whisper python -I scripts/tr.py audio.wav transcript.txt'), ['builtin-transcription', 'uv-run-env-file']],
  ['write a faster_whisper script', bash("cat > tr.py <<'EOF'\nfrom faster_whisper import WhisperModel\nEOF"), ['builtin-transcription']],
  ['install openai-whisper', bash('pip install -U openai-whisper'), ['builtin-transcription']],
  ['whisper command line', bash('whisper meeting.mp3 --model small'), ['builtin-transcription']],
  ['list a whisper folder', bash('ls whisper-models'), []],
  ['grep for whisper', bash('grep -r whisper notes/'), []],
]

describe('built-in hints: which hints each call triggers', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(matching(input)).toEqual(expected)
  })

  it('all compile into hook entries', () => {
    expect(() => createHintHookMatchers(builtinHints, () => 1)).not.toThrow()
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

describe('BUILTIN_HINTS', () => {
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
