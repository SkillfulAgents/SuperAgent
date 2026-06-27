import { describe, it, expect } from 'vitest'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { describeUnsupportedRequest, formatProviderName, isUnsupportedInChat } from './utils'

describe('formatProviderName', () => {
  it('capitalizes telegram', () => {
    expect(formatProviderName('telegram')).toBe('Telegram')
  })

  it('capitalizes slack', () => {
    expect(formatProviderName('slack')).toBe('Slack')
  })

  it('handles already-capitalized input', () => {
    expect(formatProviderName('Telegram')).toBe('Telegram')
  })

  it('handles single character', () => {
    expect(formatProviderName('x')).toBe('X')
  })

  it('handles empty string', () => {
    expect(formatProviderName('')).toBe('')
  })
})

describe('isUnsupportedInChat / describeUnsupportedRequest', () => {
  it('flags connected_account_request as unsupported and names the toolkit', () => {
    const event: UserRequestEvent = { type: 'connected_account_request', toolUseId: 't1', toolkit: 'github' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event)).toContain('github')
    expect(describeUnsupportedRequest(event)).toContain('desktop')
  })

  it('does not flag user_question_request as unsupported', () => {
    const event: UserRequestEvent = { type: 'user_question_request', toolUseId: 't2', questions: [] }
    expect(isUnsupportedInChat(event)).toBe(false)
  })

  it('flags remote_mcp_request and includes the server name when present', () => {
    const event: UserRequestEvent = { type: 'remote_mcp_request', toolUseId: 't3', url: 'https://x', name: 'Acme MCP' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event)).toContain('Acme MCP')
  })

  it('flags secret_request as unsupported (secrets are unsafe to type into chat) and names the secret', () => {
    const event: UserRequestEvent = { type: 'secret_request', toolUseId: 't4', secretName: 'OPENAI_API_KEY' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event)).toContain('OPENAI_API_KEY')
    expect(describeUnsupportedRequest(event)).toContain('desktop')
  })

  it('flags file_request as unsupported and mentions uploading', () => {
    const event: UserRequestEvent = { type: 'file_request', toolUseId: 't5', description: 'a CSV export' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event)).toContain('upload')
    expect(describeUnsupportedRequest(event)).toContain('desktop')
  })
})
