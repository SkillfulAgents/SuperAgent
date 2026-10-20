import { describe, it, expect } from 'vitest'
import { compileTrigger, globToRegExp } from './hint-matchers'

const bash = (command: unknown) => ({ event: 'PreToolUse' as const, toolName: 'Bash', toolInput: { command } })

describe('globToRegExp', () => {
  it.each([
    ['ls *', 'ls', true],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls;pwd', true],
    ['ls *', 'lsof', false],
    ['ls*', 'lsof', true],
    ['git push', 'git push', true],
    ['git push', 'git push origin main', false],
    ['git   push *', 'git push origin main', true],
    ['*--env-file*', 'uv run --env-file .env a.py', true],
  ])('%s against %s is %s', (glob, value, expected) => {
    expect(globToRegExp(glob).test(value)).toBe(expected)
  })
})

describe('compileTrigger', () => {
  it('matches a tool by name when no input is given', () => {
    const matches = compileTrigger({ event: 'PostToolUse', tool: 'Read' })
    expect(matches({ event: 'PostToolUse', toolName: 'Read', toolInput: { file_path: '/a.md' } })).toBe(true)
    expect(matches({ event: 'PostToolUse', toolName: 'Write', toolInput: {} })).toBe(false)
    expect(matches({ event: 'PreToolUse', toolName: 'Read', toolInput: {} })).toBe(false)
  })

  it.each([
    ['sleep 300', true],
    ['cd /app && sleep 300', true],
    ['npm start; sleep 60', true],
    ['false || sleep 5', true],
    ['ls | sleep 1', true],
    ['echo start\nsleep 5', true],
    ['echo sleep 5', false],
    ['cd /sleep && ls', false],
    [undefined, false],
  ])('checks each part of a chained Bash command: %s is %s', (command, expected) => {
    const matches = compileTrigger({ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *' } })
    expect(matches(bash(command))).toBe(expected)
  })

  it.each([
    ['uv run fetch.py', true],
    ['uv run --env-file .env fetch.py', false],
    ['cd /workspace && uv run fetch.py', true],
    ['uv run --env-file .env a.py && uv run b.py', true],
    ['ls', false],
  ])('unless skips the part that has the excluded text: %s is %s', (command, expected) => {
    const matches = compileTrigger({ event: 'PreToolUse', tool: 'Bash', input: { command: 'uv run *' }, unless: { command: '*--env-file*' } })
    expect(matches(bash(command))).toBe(expected)
  })

  it('matches any tool_input field as a whole value, including MCP tools', () => {
    const write = (file_path: string) => ({ event: 'PostToolUse' as const, toolName: 'Write', toolInput: { file_path } })
    const skill = compileTrigger({ event: 'PostToolUse', tool: 'Write', input: { file_path: '/workspace/.claude/skills/*' }, unless: { file_path: '*/SKILL.md' } })
    expect(skill(write('/workspace/.claude/skills/fetch-weather/weather.py'))).toBe(true)
    expect(skill(write('/workspace/.claude/skills/fetch-weather/SKILL.md'))).toBe(false)
    expect(skill(write('/workspace/notes; /workspace/.claude/skills/a.py'))).toBe(false)

    const secret = compileTrigger({ event: 'PreToolUse', tool: 'mcp__user-input__request_secret', input: { secretName: '*GITHUB*' } })
    expect(secret({ event: 'PreToolUse', toolName: 'mcp__user-input__request_secret', toolInput: { secretName: 'GITHUB_TOKEN' } })).toBe(true)
    expect(secret({ event: 'PreToolUse', toolName: 'mcp__user-input__request_secret', toolInput: { secretName: 'SLACK_TOKEN' } })).toBe(false)
  })

  it('treats a missing field as not matching input and not matching unless', () => {
    const needsPath = compileTrigger({ event: 'PostToolUse', tool: 'Write', input: { file_path: '*' } })
    const avoidsPath = compileTrigger({ event: 'PostToolUse', tool: 'Write', unless: { file_path: '*.md' } })
    const noPath = { event: 'PostToolUse' as const, toolName: 'Write', toolInput: {} }
    expect(needsPath(noPath)).toBe(false)
    expect(avoidsPath(noPath)).toBe(true)
  })

  it('matches the prompt text case-insensitively', () => {
    const matches = compileTrigger({ event: 'UserPromptSubmit', prompt: '\\bdeploy\\b' })
    expect(matches({ event: 'UserPromptSubmit', prompt: 'Please Deploy the fix' })).toBe(true)
    expect(matches({ event: 'UserPromptSubmit', prompt: 'redeployment notes' })).toBe(false)
  })
})
