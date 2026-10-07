import { describe, expect, it } from 'vitest'
import { getBlockingUserInputRequestKind, isBlockingUserInputToolName } from './user-input-tools'

describe('isBlockingUserInputToolName', () => {
  it('matches blocking user-input request tools', () => {
    expect(isBlockingUserInputToolName('AskUserQuestion')).toBe(true)
    expect(isBlockingUserInputToolName('mcp__user-input__request_secret')).toBe(true)
    expect(isBlockingUserInputToolName('mcp__user-input__request_file')).toBe(true)
  })

  it.each([
    ['AskUserQuestion', 'question'],
    ['mcp__user-input__request_secret', 'secret'],
    ['mcp__user-input__request_connected_account', 'connected_account'],
    ['mcp__user-input__request_file', 'file'],
    ['mcp__user-input__request_remote_mcp', 'remote_mcp'],
    ['mcp__user-input__request_browser_input', 'browser_input'],
  ])('resolves %s to its recovery kind', (tool, kind) => {
    expect(getBlockingUserInputRequestKind(tool)).toBe(kind)
  })

  it('excludes non-blocking and separately gated user-input tools', () => {
    expect(isBlockingUserInputToolName('mcp__user-input__request_script_run')).toBe(false)
    expect(isBlockingUserInputToolName('mcp__user-input__deliver_file')).toBe(false)
    expect(isBlockingUserInputToolName('Bash')).toBe(false)
    expect(isBlockingUserInputToolName(undefined)).toBe(false)
  })
})
