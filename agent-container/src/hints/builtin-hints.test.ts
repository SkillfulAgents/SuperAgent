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
const ran = (command: string): HintEventInput => ({ event: 'PostToolUse', toolName: 'Bash', toolInput: { command } })
const before = (toolName: string, toolInput: Record<string, unknown> = {}): HintEventInput => ({ event: 'PreToolUse', toolName, toolInput })

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
  ['read a slide deck', bash('curl -s "$PROXY_BASE_URL/acc-gslides/slides.googleapis.com/v1/presentations/abc123" -H "Authorization: Bearer $PROXY_TOKEN"'), ['shared-doc-revision']],
  ['write a doc from a script', bash('python3 - <<\'EOF\'\nbase = f"{proxy}/acc-gdocs/docs.googleapis.com/v1/documents/{doc_id}"\nrequests.post(base + ":batchUpdate", json=body)\nEOF'), ['python-stdlib-only', 'shared-doc-revision']],
  ['sheets batchUpdate', bash('curl -s -X POST "$PROXY_BASE_URL/acc-gsheets/sheets.googleapis.com/v4/spreadsheets/abc:batchUpdate"'), []],
  ['sleep', bash('sleep 30'), ['no-foreground-wait']],
  ['poll loop', bash('for i in $(seq 1 18); do curl -s "$URL/check-runs"; sleep 10; done'), ['no-foreground-wait']],
  ['background sleep', { event: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'sleep 10 && echo done', run_in_background: true } }, ['no-foreground-wait']],
  ['background command', bash('npm test > /tmp/test.log 2>&1'), []],
  ['write a CSV report', wrote('/workspace/reports/activations.csv'), ['deliver-files']],
  ['write a PDF', wrote('/workspace/invoice.pdf'), ['deliver-files']],
  ['write a temp CSV', wrote('/tmp/scratch.csv'), []],
  ['script made a spreadsheet', ran("uv run --with openpyxl python - <<'EOF'\nfrom openpyxl import Workbook\nwb = Workbook()\nwb.save('/workspace/reports/q3.xlsx')\nEOF"), ['deliver-files']],
  ['script made a slide deck', ran("python3 - <<'EOF'\nfrom pptx import Presentation\nEOF"), ['deliver-files']],
  ['script wrote a CSV with pandas', ran('uv run --with pandas python -c "import pandas as pd; pd.DataFrame(rows).to_csv(\'/workspace/out.csv\')"'), ['deliver-files']],
  ['script read a CSV', ran('uv run --with pandas python -c "import pandas as pd; print(pd.read_csv(\'/workspace/in.csv\').shape)"'), []],
  ['grep a CSV', ran('grep -c signup /workspace/reports/signups.csv'), []],
  ['agent-browser and uv run in one command', bash('agent-browser snapshot && uv run report.py'), ['agent-browser-bash', 'uv-run-env-file']],
  ['wait, then print secrets', bash('sleep 2; cat /workspace/.env'), ['no-foreground-wait', 'no-secret-values']],
  ['wait, then write a deck', bash('sleep 5 && uv run --env-file .env python - <<\'EOF\'\nurl = f"{proxy}/acc-gslides/slides.googleapis.com/v1/presentations/{pid}:batchUpdate"\nEOF'), ['no-foreground-wait', 'shared-doc-revision', 'uv-run-env-file']],
  ['propose an API rule', before('mcp__rules__create_api_rule', { accountId: 'acc-shopify', effect: 'require' }), ['create-rule']],
  ['propose an MCP rule', before('mcp__rules__create_mcp_rule', { mcpId: 'linear' }), ['create-rule']],
  ['list rules', before('mcp__rules__list_proxy_rules', { kind: 'api', targetId: 'acc-shopify' }), []],
  ['invoke another agent', before('mcp__agents__invoke_agent', { slug: 'outreach', prompt: 'Import /workspace/attendees.csv' }), ['invoke-agent-files']],
  ['read another agent transcript', before('mcp__agents__get_agent_session_transcript', { slug: 'outreach', session_id: 's1', sync: true }), []],
  ['inspect webhook events', before('mcp__user-input__inspect_webhook_events', { trigger_id: 'wt_lunch1' }), ['inspect-webhook-events']],
  ['list triggers', before('mcp__user-input__list_triggers'), []],
  ['write a skill file', before('Write', { file_path: '/workspace/.claude/skills/signup-abuse-monitor/SKILL.md' }), ['live-skill-edit']],
  ['edit a skill script', before('Edit', { file_path: '/workspace/.claude/skills/fetch-weather/weather.py' }), ['live-skill-edit']],
  ['write a draft outside skills', before('Write', { file_path: '/workspace/drafts/signup-abuse-monitor.md' }), []],
  ['sentry issue search with OR', before('mcp__sentry__search_issues', { query: 'is:unresolved (project:api OR project:web)' }), ['sentry-search-no-boolean']],
  ['sentry issue search with AND', before('mcp__sentry__search_issues', { query: 'is:unresolved AND level:error' }), ['sentry-search-no-boolean']],
  ['sentry issue search', before('mcp__sentry__search_issues', { query: 'is:unresolved lastSeen:-7d' }), []],
  ['sentry word containing or', before('mcp__sentry__search_issues', { query: 'message:"order failed"' }), []],
  ['supabase SQL', before('mcp__supabase__execute_sql', { project_id: 'abc', query: 'select id from public.orders limit 5' }), ['supabase-check-columns']],
  ['supabase list tables', before('mcp__supabase__list_tables', { project_id: 'abc' }), []],
  ['linear list issues', before('mcp__linear__list_issues', { assignee: 'me', fields: ['title', 'updatedAt'] }), ['linear-fields-and-ids']],
  ['linear get issue', before('mcp__linear__get_issue', { id: 'ENG-241' }), ['linear-fields-and-ids']],
  ['linear list teams', before('mcp__linear__list_teams'), []],
  ['customer.io read API', before('mcp__customer_io__cio_read_api', { path: '/v1/environments/{environment_id}/campaigns' }), ['customer-io-schema-first']],
  ['customer.io write API', before('mcp__customer_io__cio_write_api', { path: '/v1/environments/{environment_id}/campaigns/{campaign_id}', method: 'PUT' }), ['customer-io-schema-first']],
  ['customer.io schema', before('mcp__customer_io__cio_schema', { path: '/v1/environments/{environment_id}/campaigns' }), []],
  ['proxy POST with -d', bash('curl -s -X POST "$PROXY_BASE_URL/acc-hubspot/api.hubapi.com/crm/v3/objects/contacts" -H "Authorization: Bearer $PROXY_TOKEN" -d "email=ann@example.com"'), ['proxy-json-body']],
  ['proxy POST with -d before the URL', bash('curl -s -d "name=Ann" "$PROXY_BASE_URL/acc-crm/api.example.com/v1/leads"'), ['proxy-json-body']],
  ['proxy POST with --data-binary', bash('curl -s "$PROXY_BASE_URL/acc-drive/www.googleapis.com/upload/drive/v3/files" --data-binary @report.pdf'), ['proxy-json-body']],
  ['proxy GET', bash('curl -s "$PROXY_BASE_URL/acc-gmail/gmail.googleapis.com/gmail/v1/users/me/profile" -H "Authorization: Bearer $PROXY_TOKEN"'), []],
  ['curl -d without the proxy', bash('curl -s -d "q=1" https://api.example.com/search'), []],
  ['python3 script', bash('python3 /workspace/scripts/report.py --days 7'), ['python-stdlib-only']],
  ['python -c after cd', bash('cd /workspace && python -c "import json; print(1)"'), ['python-stdlib-only']],
  ['python3 heredoc', bash("python3 - <<'EOF'\nprint('hi')\nEOF"), ['python-stdlib-only']],
  ['python through uv run', bash('uv run --env-file .env --with requests python fetch.py'), ['uv-run-env-file']],
  ['python3.12 binary', bash('python3.12 fetch.py'), []],
  ['pip install', bash('pip install requests'), []],
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
