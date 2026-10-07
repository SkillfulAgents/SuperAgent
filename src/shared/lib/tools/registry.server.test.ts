import { describe, expect, it, vi } from 'vitest'

// Backend consumers must be able to use definitions without loading any UI.
vi.mock('react', () => { throw new Error('Shared registry imported React') })
vi.mock('react/jsx-runtime', () => { throw new Error('Shared registry imported JSX') })
vi.mock('lucide-react', () => { throw new Error('Shared registry imported icons') })

import { getRequestDefinition, getToolDefinition } from './registry'
import { USER_INPUT_REQUEST_KINDS, type UserInputRequestKind } from './requests/request-schema'

describe('server-safe request registry', () => {
  it('covers every wire request kind', () => {
    for (const kind of USER_INPUT_REQUEST_KINDS) {
      expect(getRequestDefinition(kind).getNotification).toBeTypeOf('function')
    }
  })

  it('uses the same definition for a tool and its request', () => {
    expect(getRequestDefinition('secret')).toBe(
      getToolDefinition('mcp__user-input__request_secret')?.request,
    )
  })

  const waitingCases: [UserInputRequestKind, Record<string, unknown>, string][] = [
    ['secret', {}, 'needs a secret value'],
    ['connected_account', {}, 'needs account access'],
    ['question', {}, 'has a question for you'],
    ['file', {}, 'needs a file from you'],
    ['remote_mcp', {}, 'needs access to an MCP server'],
    ['browser_input', {}, 'needs your browser input'],
    ['script_run', {}, 'wants to run a script on your machine'],
    ['computer_use', {}, 'wants to control your computer'],
    ['capability_review', { capability: 'workflows' }, 'wants to run a workflow'],
    ['capability_review', { capability: 'subagents' }, 'wants to launch a subagent'],
    ['capability_review', {}, 'wants to launch a subagent'],
  ]

  it.each(waitingCases)('preserves notification text for %s (%j)', (kind, payload, message) => {
    expect(getRequestDefinition(kind).getNotification('Atlas', payload)).toEqual({
      title: 'Action Required', body: `Atlas ${message}`,
    })
  })

  it.each([
    ['proxy_review', 'API Request Review'],
    ['x_agent_review', 'Agent Action Review'],
  ] as const)('preserves %s titles and review descriptions', (kind, suffix) => {
    const definition = getRequestDefinition(kind)
    expect(definition.getNotification('Atlas', { displayText: 'Review this action' })).toEqual({
      title: `Atlas — ${suffix}`, body: 'Review this action',
    })
    expect(definition.getNotification('Atlas', {})?.body).toBe('API request review')
  })

  it.each(['account_reauth_required', 'mcp_reauth_required'] as const)(
    'keeps %s limited to its in-app card',
    (kind) => expect(getRequestDefinition(kind).getNotification('Atlas', {})).toBeNull(),
  )
})
