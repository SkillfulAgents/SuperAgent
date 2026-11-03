import { describe, it, expect } from 'vitest'
import { compileGlob, compileTrigger } from './hint-matchers'

const bash = (command: unknown) => ({ event: 'PreToolUse' as const, toolName: 'Bash', toolInput: { command } })

describe('compileGlob', () => {
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
    ['git push', 'git  push', true],
    ['git push', 'gitpush', false],
    ['*.env', 'cat /workspace/.env', true],
    ['*.env', 'cat /workspace/.env.bak', false],
    ['cat *.env*', 'cat /workspace/.env.bak', true],
    ['*a*b*', 'b a', false],
    ['* -d *', 'curl -dx url -d body', true],
    ['* -d *', 'curl -dx url', false],
    ['*slides*batchUpdate*', 'url = "slides/v1"\nrequests.post(url + ":batchUpdate")', true],
  ])('%s against %s is %s', (glob, value, expected) => {
    expect(compileGlob(glob)(value)).toBe(expected)
  })

  it('stays fast on a long command that almost matches', () => {
    expect(compileGlob('*a*b*c*d*zzz*')('a b c d '.repeat(2000))).toBe(false)
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

  it('matches any tool_input field as a whole value, including MCP tools', () => {
    const write = (file_path: string) => ({ event: 'PostToolUse' as const, toolName: 'Write', toolInput: { file_path } })
    const skill = compileTrigger({ event: 'PostToolUse', tool: 'Write', input: { file_path: '/workspace/.claude/skills/*' } })
    expect(skill(write('/workspace/.claude/skills/fetch-weather/weather.py'))).toBe(true)
    expect(skill(write('/workspace/.claude/skills-old/weather.py'))).toBe(false)
    expect(skill(write('/workspace/notes; /workspace/.claude/skills/a.py'))).toBe(false)

    const secret = compileTrigger({ event: 'PreToolUse', tool: 'mcp__user-input__request_secret', input: { secretName: '*GITHUB*' } })
    expect(secret({ event: 'PreToolUse', toolName: 'mcp__user-input__request_secret', toolInput: { secretName: 'GITHUB_TOKEN' } })).toBe(true)
    expect(secret({ event: 'PreToolUse', toolName: 'mcp__user-input__request_secret', toolInput: { secretName: 'SLACK_TOKEN' } })).toBe(false)
  })

  it('compares boolean and number fields as text', () => {
    const background = compileTrigger({ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *', run_in_background: 'true' } })
    const call = (run_in_background?: boolean) => ({ event: 'PreToolUse' as const, toolName: 'Bash', toolInput: { command: 'sleep 10', run_in_background } })
    expect(background(call(true))).toBe(true)
    expect(background(call(false))).toBe(false)
    expect(background(call())).toBe(false)
  })

  it('treats a missing field as not matching', () => {
    const needsPath = compileTrigger({ event: 'PostToolUse', tool: 'Write', input: { file_path: '*' } })
    expect(needsPath({ event: 'PostToolUse', toolName: 'Write', toolInput: {} })).toBe(false)
  })

  it('matches the prompt text case-insensitively', () => {
    const matches = compileTrigger({ event: 'UserPromptSubmit', prompt: '\\bdeploy\\b' })
    expect(matches({ event: 'UserPromptSubmit', prompt: 'Please Deploy the fix' })).toBe(true)
    expect(matches({ event: 'UserPromptSubmit', prompt: 'redeployment notes' })).toBe(false)
  })
})
