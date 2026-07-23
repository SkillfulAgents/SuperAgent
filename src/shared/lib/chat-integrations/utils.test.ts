import { afterEach, describe, it, expect } from 'vitest'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import {
  describeUnsupportedRequest,
  formatProviderName,
  isSettling,
  isUnsupportedInChat,
  resolveAppLinkContext,
  type AppLinkContext,
} from './utils'

const desktopContext: AppLinkContext = {
  isDesktop: true,
  url: 'superagent://agent/demo',
}

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

describe('isSettling', () => {
  it('is true only when active but not yet connected (the "Connecting…" state)', () => {
    expect(isSettling('active', false)).toBe(true)
    expect(isSettling('active', undefined)).toBe(true)
  })

  it('is false once connected, and for every non-active status', () => {
    expect(isSettling('active', true)).toBe(false)
    expect(isSettling('paused', false)).toBe(false)
    expect(isSettling('error', false)).toBe(false)
    expect(isSettling('disconnected', false)).toBe(false)
  })
})

describe('resolveAppLinkContext', () => {
  const originalType = (process as { type?: string }).type
  const originalProtocol = process.env.SUPERAGENT_PROTOCOL
  const originalHostPublicUrl = process.env.HOST_PUBLIC_URL

  afterEach(() => {
    if (originalType === undefined) {
      delete (process as { type?: string }).type
    } else {
      ;(process as { type?: string }).type = originalType
    }
    if (originalProtocol === undefined) {
      delete process.env.SUPERAGENT_PROTOCOL
    } else {
      process.env.SUPERAGENT_PROTOCOL = originalProtocol
    }
    if (originalHostPublicUrl === undefined) {
      delete process.env.HOST_PUBLIC_URL
    } else {
      process.env.HOST_PUBLIC_URL = originalHostPublicUrl
    }
  })

  it('returns a desktop deeplink when process.type is browser', () => {
    ;(process as { type?: string }).type = 'browser'
    process.env.SUPERAGENT_PROTOCOL = 'superagent-dev'
    delete process.env.HOST_PUBLIC_URL

    expect(resolveAppLinkContext('my-agent')).toEqual({
      isDesktop: true,
      url: 'superagent-dev://agent/my-agent',
    })
  })

  it('falls back to the superagent scheme when SUPERAGENT_PROTOCOL is unset', () => {
    ;(process as { type?: string }).type = 'browser'
    delete process.env.SUPERAGENT_PROTOCOL

    expect(resolveAppLinkContext('demo').url).toBe('superagent://agent/demo')
  })

  it('returns a web URL when HOST_PUBLIC_URL is set outside Electron', () => {
    delete (process as { type?: string }).type
    process.env.HOST_PUBLIC_URL = 'https://app.example.com/'

    expect(resolveAppLinkContext('my-agent')).toEqual({
      isDesktop: false,
      url: 'https://app.example.com/agents/my-agent',
    })
  })

  it('returns null web url when HOST_PUBLIC_URL is unset or empty', () => {
    delete (process as { type?: string }).type
    delete process.env.HOST_PUBLIC_URL
    expect(resolveAppLinkContext('demo')).toEqual({ isDesktop: false, url: null })

    process.env.HOST_PUBLIC_URL = ''
    expect(resolveAppLinkContext('demo')).toEqual({ isDesktop: false, url: null })

    process.env.HOST_PUBLIC_URL = '   '
    expect(resolveAppLinkContext('demo')).toEqual({ isDesktop: false, url: null })
  })

  it('URI-encodes the agent slug', () => {
    delete (process as { type?: string }).type
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    expect(resolveAppLinkContext('a/b c').url).toBe('https://app.example.com/agents/a%2Fb%20c')

    ;(process as { type?: string }).type = 'browser'
    process.env.SUPERAGENT_PROTOCOL = 'superagent'
    expect(resolveAppLinkContext('a/b c').url).toBe('superagent://agent/a%2Fb%20c')
  })
})

describe('isUnsupportedInChat / describeUnsupportedRequest', () => {
  it('flags connected_account_request as unsupported and names the toolkit', () => {
    const event: UserRequestEvent = { type: 'connected_account_request', toolUseId: 't1', toolkit: 'github' }
    expect(isUnsupportedInChat(event)).toBe(true)
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('github')
    expect(describeUnsupportedRequest(event, desktopContext)).toContain('desktop')
  })

  it('does not flag user_question_request as unsupported', () => {
    const event: UserRequestEvent = { type: 'user_question_request', toolUseId: 't2', questions: [] }
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
