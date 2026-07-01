import { describe, expect, it } from 'vitest'
import { isBlockingUserInputToolName } from './user-input-tools'

describe('isBlockingUserInputToolName', () => {
  it('matches blocking user-input request tools', () => {
    expect(isBlockingUserInputToolName('AskUserQuestion')).toBe(true)
    expect(isBlockingUserInputToolName('mcp__user-input__request_secret')).toBe(true)
    expect(isBlockingUserInputToolName('mcp__user-input__request_file')).toBe(true)
  })

  it('excludes non-blocking and separately gated user-input tools', () => {
    expect(isBlockingUserInputToolName('mcp__user-input__request_script_run')).toBe(false)
    expect(isBlockingUserInputToolName('mcp__user-input__deliver_file')).toBe(false)
    expect(isBlockingUserInputToolName('Bash')).toBe(false)
    expect(isBlockingUserInputToolName(undefined)).toBe(false)
  })
})
