import { describe, it, expect } from 'vitest'
import { compileTrigger, toolPatternToRegExp } from './hint-matchers'

describe('toolPatternToRegExp', () => {
  it.each([
    ['ls *', 'ls', true],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls;pwd', true],
    ['ls *', 'lsof', false],
    ['ls*', 'lsof', true],
    ['git push', 'git push', true],
    ['git push', 'git push origin main', false],
    ['git   push *', 'git push origin main', true],
  ])('%s against %s is %s', (pattern, command, expected) => {
    expect(toolPatternToRegExp(pattern).test(command)).toBe(expected)
  })
})

describe('compileTrigger', () => {
  it('matches a tool name without a pattern', () => {
    const matches = compileTrigger({ event: 'PostToolUse', match: 'Read' })
    expect(matches({ event: 'PostToolUse', toolName: 'Read', toolInput: { file_path: '/a.md' } })).toBe(true)
    expect(matches({ event: 'PostToolUse', toolName: 'Write', toolInput: {} })).toBe(false)
    expect(matches({ event: 'PreToolUse', toolName: 'Read', toolInput: {} })).toBe(false)
  })

  it('matches the prompt text case-insensitively', () => {
    const matches = compileTrigger({ event: 'UserPromptSubmit', match: '\\bdeploy\\b' })
    expect(matches({ event: 'UserPromptSubmit', prompt: 'Please Deploy the fix' })).toBe(true)
    expect(matches({ event: 'UserPromptSubmit', prompt: 'redeployment notes' })).toBe(false)
  })

  it('rejects a pattern on a tool with no pattern field', () => {
    expect(() => compileTrigger({ event: 'PreToolUse', match: 'Read(/tmp/*)' })).toThrow('does not support')
  })

  it('rejects a malformed tool match', () => {
    expect(() => compileTrigger({ event: 'PreToolUse', match: 'Bash(sleep *' })).toThrow('Invalid tool match')
  })
})
