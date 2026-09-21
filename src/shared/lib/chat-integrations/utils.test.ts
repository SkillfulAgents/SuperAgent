import { describe, it, expect } from 'vitest'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { AppLinkContext } from '../agent-integrations/app-link'
import { describeUnsupportedRequest, isUnsupportedInChat } from './utils'

const desktopContext: AppLinkContext = { isDesktop: true, url: 'superagent://agent/demo' }

describe('isUnsupportedInChat / describeUnsupportedRequest', () => {
  it('flags connected_account_request as unsupported and names the toolkit', () => {
    const event: UserRequestEvent = { type: 'connected_account_request', toolUseId: 't1', toolkit: 'github' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('github')
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('desktop')
  })

  it('does not flag question_request as unsupported', () => {
    const event: UserRequestEvent = { type: 'question_request', toolUseId: 't2', questions: [] }
    expect(isUnsupportedInChat(event)).toBe(false)
  })

  it('flags remote_mcp_request and includes the server name when present', () => {
    const event: UserRequestEvent = { type: 'remote_mcp_request', toolUseId: 't3', url: 'https://x', name: 'Acme MCP' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('Acme MCP')
  })

  it('flags secret_request as unsupported (secrets are unsafe to type into chat) and names the secret', () => {
    const event: UserRequestEvent = { type: 'secret_request', toolUseId: 't4', secretName: 'OPENAI_API_KEY' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('OPENAI_API_KEY')
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('desktop')
  })

  it('flags file_request as unsupported and mentions uploading', () => {
    const event: UserRequestEvent = { type: 'file_request', toolUseId: 't5', description: 'a CSV export' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('upload')
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('desktop')
  })

  it('desktop context includes desktop wording and the deeplink', () => {
    const event: UserRequestEvent = {
      type: 'script_run_request',
      toolUseId: 't6',
      script: 'echo hi',
      explanation: 'test',
      scriptType: 'bash',
    }
    const message = describeUnsupportedRequest(event, desktopContext)
    expect(message).toContain('on your desktop')
    expect(message).toContain('superagent://agent/demo')
  })

  it('web context with url omits desktop and includes the url', () => {
    const event: UserRequestEvent = {
      type: 'script_run_request',
      toolUseId: 't7',
      script: 'echo hi',
      explanation: 'test',
      scriptType: 'bash',
    }
    const message = describeUnsupportedRequest(event, {
      isDesktop: false,
      url: 'https://app.example.com/agents/demo',
    })
    expect(message).not.toContain('desktop')
    expect(message).toContain('Open Gamut to continue: https://app.example.com/agents/demo')
  })

  it('web context with null url omits desktop, ends with a period, and has no dangling colon', () => {
    const event: UserRequestEvent = {
      type: 'script_run_request',
      toolUseId: 't8',
      script: 'echo hi',
      explanation: 'test',
      scriptType: 'bash',
    }
    const message = describeUnsupportedRequest(event, { isDesktop: false, url: null })
    expect(message).not.toContain('desktop')
    expect(message).toMatch(/to continue\.$/)
    expect(message).not.toContain('continue:')
  })

  it('no-context fallback keeps current desktop wording with no link', () => {
    const event: UserRequestEvent = {
      type: 'script_run_request',
      toolUseId: 't9',
      script: 'echo hi',
      explanation: 'test',
      scriptType: 'bash',
    }
    const message = describeUnsupportedRequest(event)
    expect(message).toContain('Open Gamut on your desktop to continue.')
    expect(message).not.toContain('://')
  })
})
