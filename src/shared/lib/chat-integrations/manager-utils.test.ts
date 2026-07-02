import { describe, it, expect } from 'vitest'
import { deriveDisplayName, isUserRequestTool, isDisplayNameFallback, formatSessionTimestamp, buildSessionName } from './chat-integration-manager'

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

// ── formatSessionTimestamp ─────────────────────────────────────────────

describe('formatSessionTimestamp', () => {
  it('includes month, day, and time', () => {
    const result = formatSessionTimestamp(new Date('2026-05-20T14:30:00'))
    expect(result).toContain('May')
    expect(result).toContain('20')
    expect(result).toMatch(/2:30\s*PM/)
  })

  it('uses 12-hour format with AM/PM', () => {
    const morning = formatSessionTimestamp(new Date('2026-01-15T09:05:00'))
    expect(morning).toMatch(/9:05\s*AM/)
    expect(morning).toContain('Jan')
    expect(morning).toContain('15')
  })

  it('handles midnight correctly', () => {
    const midnight = formatSessionTimestamp(new Date('2026-03-01T00:00:00'))
    expect(midnight).toMatch(/12:00\s*AM/)
  })

  it('handles noon correctly', () => {
    const noon = formatSessionTimestamp(new Date('2026-07-04T12:00:00'))
    expect(noon).toMatch(/12:00\s*PM/)
  })
})

// ── buildSessionName ──────────────────────────────────────────────────

describe('buildSessionName', () => {
  it('uses integration name and display name', () => {
    expect(buildSessionName('My Bot', 'telegram', 'Alice', null)).toBe('My Bot — Alice')
  })

  it('falls back to provider when integration name is null', () => {
    expect(buildSessionName(null, 'telegram', 'Alice', null)).toBe('telegram — Alice')
  })

  it('uses integration name alone when no display name', () => {
    expect(buildSessionName('My Bot', 'telegram', undefined, null)).toBe('My Bot')
  })

  it('falls back to "<provider> chat" when no name and no display name', () => {
    expect(buildSessionName(null, 'slack', undefined, null)).toBe('slack chat')
  })

  it('appends timestamp when timeout is set', () => {
    const now = new Date('2026-05-20T14:30:00')
    const name = buildSessionName('My Bot', 'telegram', 'Alice', 4, now)
    expect(name).toMatch(/^My Bot — Alice — May 20/)
    expect(name).toMatch(/2:30\s*PM$/)
  })

  it('appends timestamp without display name when timeout is set', () => {
    const now = new Date('2026-01-15T09:05:00')
    const name = buildSessionName('My Bot', 'telegram', undefined, 1, now)
    expect(name).toMatch(/^My Bot — Jan 15/)
    expect(name).toMatch(/9:05\s*AM$/)
  })

  it('does NOT append timestamp when timeout is null', () => {
    const name = buildSessionName('My Bot', 'telegram', 'Alice', null)
    expect(name).toBe('My Bot — Alice')
  })

  it('does NOT append timestamp when timeout is 0', () => {
    const name = buildSessionName('My Bot', 'telegram', 'Alice', 0)
    expect(name).toBe('My Bot — Alice')
  })
})
