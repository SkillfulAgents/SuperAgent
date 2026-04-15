import { describe, it, expect } from 'vitest'
import { deriveDisplayName, isUserRequestTool, isDisplayNameFallback } from './chat-integration-manager'

// ── deriveDisplayName ───────────────────────────────────────────────────

describe('deriveDisplayName', () => {
  it('prefers chatName (group/channel title)', () => {
    expect(deriveDisplayName({
      chatName: '#general',
      userName: 'Alice',
      userId: 'U123',
    })).toBe('#general')
  })

  it('falls back to userName when chatName is undefined', () => {
    expect(deriveDisplayName({
      chatName: undefined,
      userName: 'Alice',
      userId: 'U123',
    })).toBe('Alice')
  })

  it('falls back to userName when chatName is empty string', () => {
    expect(deriveDisplayName({
      chatName: '',
      userName: 'Alice',
      userId: 'U123',
    })).toBe('Alice')
  })

  it('falls back to "User <id>" when both chatName and userName are undefined', () => {
    expect(deriveDisplayName({
      chatName: undefined,
      userName: undefined,
      userId: 'U08G596PMC6',
    })).toBe('User U08G596PMC6')
  })

  it('returns undefined when all fields are empty', () => {
    expect(deriveDisplayName({
      chatName: undefined,
      userName: undefined,
      userId: '',
    })).toBeUndefined()
  })

  it('returns undefined when all fields are undefined', () => {
    expect(deriveDisplayName({
      chatName: undefined,
      userName: undefined,
      userId: undefined as any,
    })).toBeUndefined()
  })

  it('does not use chatName for Slack DMs (caller passes undefined)', () => {
    // Slack connector returns undefined for DM chatName — simulate that
    expect(deriveDisplayName({
      chatName: undefined,
      userName: 'Iddo Gino',
      userId: 'U08G596PMC6',
    })).toBe('Iddo Gino')
  })
})

// ── isDisplayNameFallback ───────────────────────────────────────────────

describe('isDisplayNameFallback', () => {
  it('returns true for null', () => {
    expect(isDisplayNameFallback(null)).toBe(true)
  })

  it('returns true for undefined', () => {
    expect(isDisplayNameFallback(undefined)).toBe(true)
  })

  it('returns true for empty string', () => {
    expect(isDisplayNameFallback('')).toBe(true)
  })

  it('returns true for "User U08G596PMC6"', () => {
    expect(isDisplayNameFallback('User U08G596PMC6')).toBe(true)
  })

  it('returns true for "User 123456"', () => {
    expect(isDisplayNameFallback('User 123456')).toBe(true)
  })

  it('returns false for a real name', () => {
    expect(isDisplayNameFallback('Iddo Gino')).toBe(false)
  })

  it('returns false for a channel name', () => {
    expect(isDisplayNameFallback('#general')).toBe(false)
  })

  it('returns false for a group DM title', () => {
    expect(isDisplayNameFallback('Project Discussion')).toBe(false)
  })
})

// ── isUserRequestTool ───────────────────────────────────────────────────

describe('isUserRequestTool', () => {
  const knownTools = [
    'AskUserQuestion',
    'mcp__user-input__request_secret',
    'mcp__user-input__request_file',
    'mcp__user-input__deliver_file',
    'mcp__user-input__request_connected_account',
    'mcp__user-input__request_remote_mcp',
    'mcp__user-input__request_browser_input',
    'mcp__user-input__request_script_run',
  ]

  for (const tool of knownTools) {
    it(`recognizes ${tool}`, () => {
      expect(isUserRequestTool(tool)).toBe(true)
    })
  }

  it('rejects regular tool names', () => {
    expect(isUserRequestTool('Bash')).toBe(false)
    expect(isUserRequestTool('Read')).toBe(false)
    expect(isUserRequestTool('Edit')).toBe(false)
    expect(isUserRequestTool('mcp__some-server__some_tool')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isUserRequestTool('')).toBe(false)
  })

  it('rejects partial matches', () => {
    expect(isUserRequestTool('AskUser')).toBe(false)
    expect(isUserRequestTool('mcp__user-input__request')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(isUserRequestTool('askuserquestion')).toBe(false)
    expect(isUserRequestTool('ASKUSERQUESTION')).toBe(false)
  })
})
