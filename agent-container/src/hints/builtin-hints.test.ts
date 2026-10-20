import { describe, it, expect } from 'vitest'
import { builtinHints } from './index'
import { compileTrigger } from './hint-matchers'
import type { HintEventInput } from './hint-schema'

const compiled = builtinHints.map((hint) => ({ name: hint.name, triggers: hint.triggers.map(compileTrigger) }))
const matching = (input: HintEventInput) => compiled.filter(({ triggers }) => triggers.some((m) => m(input))).map(({ name }) => name).sort()

const bash = (command: string): HintEventInput => ({ event: 'PreToolUse', toolName: 'Bash', toolInput: { command } })
const read = (file_path: string): HintEventInput => ({ event: 'PreToolUse', toolName: 'Read', toolInput: { file_path } })
const wrote = (file_path: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Write', toolInput: { file_path } })
const edited = (file_path: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Edit', toolInput: { file_path } })

// Every row lists the exact hints a call triggers. A new hint that also fires on another hint's example
// fails here, so its author decides whether both should fire.
const CASES: Array<[string, HintEventInput, string[]]> = [
  ['agent-browser command', bash('agent-browser open https://example.com'), ['agent-browser-bash']],
  ['agent-browser lookup', bash('which agent-browser'), ['agent-browser-bash']],
  ['uv run without env file', bash('uv run --with requests fetch.py'), ['uv-run-env-file']],
  ['uv run with env file', bash('uv run --env-file .env --with requests fetch.py'), []],
  ['write a skill script', wrote('/workspace/.claude/skills/fetch-weather/weather.py'), ['update-skill-md']],
  ['edit SKILL.md itself', edited('/workspace/.claude/skills/fetch-weather/SKILL.md'), []],
  ['print the env file', bash('cat /workspace/.env'), ['no-secret-values']],
  ['grep the environment', bash('env | grep -i crm'), ['no-secret-values']],
  ['printenv', bash('printenv CRM_API_KEY'), ['no-secret-values']],
  ['read the env file', read('/workspace/.env'), ['no-secret-values']],
  ['read a normal file', read('/workspace/notes/plan.md'), []],
  ['category is not cat', bash('category=reports; ls $category'), []],
  ['read a slide deck', bash('curl -s "$PROXY_BASE_URL/acc-gslides/slides.googleapis.com/v1/presentations/abc123" -H "Authorization: Bearer $PROXY_TOKEN"'), ['shared-doc-revision']],
  ['write a doc from a script', bash('python3 - <<\'EOF\'\nbase = f"{proxy}/acc-gdocs/docs.googleapis.com/v1/documents/{doc_id}"\nrequests.post(base + ":batchUpdate", json=body)\nEOF'), ['shared-doc-revision']],
  ['sheets batchUpdate', bash('curl -s -X POST "$PROXY_BASE_URL/acc-gsheets/sheets.googleapis.com/v4/spreadsheets/abc:batchUpdate"'), []],
  ['sleep', bash('sleep 30'), ['no-foreground-wait']],
  ['poll loop', bash('for i in $(seq 1 18); do curl -s "$URL/check-runs"; sleep 10; done'), ['no-foreground-wait']],
  ['background command', bash('npm test > /tmp/test.log 2>&1'), []],
  ['write a CSV report', wrote('/workspace/reports/activations.csv'), ['deliver-files']],
  ['write a PDF', wrote('/workspace/invoice.pdf'), ['deliver-files']],
  ['write a temp CSV', wrote('/tmp/scratch.csv'), []],
  ['agent-browser and uv run in one command', bash('agent-browser snapshot && uv run report.py'), ['agent-browser-bash', 'uv-run-env-file']],
  ['wait, then print secrets', bash('sleep 2; cat /workspace/.env'), ['no-foreground-wait', 'no-secret-values']],
  ['wait, then write a deck', bash('sleep 5 && uv run --env-file .env python - <<\'EOF\'\nurl = f"{proxy}/acc-gslides/slides.googleapis.com/v1/presentations/{pid}:batchUpdate"\nEOF'), ['no-foreground-wait', 'shared-doc-revision']],
]

describe('built-in hints: which hints each call triggers', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(matching(input)).toEqual(expected)
  })

  it('every built-in hint has at least one example here', () => {
    const covered = new Set(CASES.flatMap(([, , names]) => names))
    expect(builtinHints.map((h) => h.name).filter((name) => !covered.has(name))).toEqual([])
  })
})
