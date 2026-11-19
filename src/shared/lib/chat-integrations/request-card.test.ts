import { describe, it, expect } from 'vitest'
import { requestCardFromRegistry, reviewCardFromRegistry } from './request-card'
import {
  pendingUserInputRequestSchema,
  USER_INPUT_REQUEST_KINDS,
  type PendingUserInputRequest,
} from '@shared/lib/tools/requests/request-schema'
import { isUnsupportedInChat, describeUnsupportedRequest } from './utils'

/** A real registry envelope — parsed, so a card can only come from a valid one. */
function request(
  kind: string,
  payload: Record<string, unknown> = {},
  // null omits the field (undefined would take the default).
  over: { id?: string; autoApproved?: boolean; agentSlug?: string | null; sessionId?: string | null } = {},
): PendingUserInputRequest {
  return pendingUserInputRequestSchema.parse({
    id: over.id ?? 'req-1',
    kind,
    scope: {
      ...(over.agentSlug === null ? {} : { agentSlug: over.agentSlug ?? 'agent-a' }),
      ...(over.sessionId === null ? {} : { sessionId: over.sessionId ?? 'session-1' }),
    },
    blocking: true,
    autoApproved: over.autoApproved ?? false,
    payload,
  })
}

describe('requestCardFromRegistry', () => {
  it('carries the payload through under the card type the connectors switch on', () => {
    const card = requestCardFromRegistry(
      request('secret', { secretName: 'API_KEY', reason: 'Need it' }, { id: 'tu-9' }),
    )
    expect(card).toEqual({
      type: 'secret_request',
      toolUseId: 'tu-9',
      secretName: 'API_KEY',
      reason: 'Need it',
      agentSlug: 'agent-a',
    })
  })

  it('never lets a payload field overwrite the identity fields', () => {
    // The payload is whatever the model put in the tool input; it must not be
    // able to redirect the card to another type or another request's id.
    const card = requestCardFromRegistry(
      request('secret', { type: 'question_request', toolUseId: 'someone-else', secretName: 'K' }),
    )
    expect(card).toMatchObject({ type: 'secret_request', toolUseId: 'req-1' })
  })

  it('asks a page\'s ways to verify as a question chat can answer, and leaves the rest of a sign-in to the app', () => {
    const ways = [
      { label: 'Get a code at •••12', method: 'text_message', clickable: true },
      { label: 'Tap Yes on your phone', method: 'phone_prompt', clickable: true },
    ]
    const card = requestCardFromRegistry(request('login', { message: 'Sign in.', origin: 'https://github.com', fields: [], ways }, { id: 'tu-7' }))
    expect(card).toEqual({
      type: 'question_request',
      toolUseId: 'tu-7',
      questions: [{
        question: 'github.com asks how to verify it\'s you. Which way? It is clicked on the page for you.',
        options: [{ label: 'Get a code at •••12' }, { label: 'Tap Yes on your phone' }],
      }],
      agentSlug: 'agent-a',
    })
    expect(isUnsupportedInChat(card!)).toBe(false)

    // The page's only way, with nothing to click: answered with Done.
    const prompt = requestCardFromRegistry(request('login', { message: 'Sign in.', origin: 'https://github.com', fields: [], ways: [{ ...ways[1], clickable: false }] }))
    expect(prompt).toMatchObject({ type: 'question_request', questions: [{ options: [{ label: 'Done' }] }] })

    const form = requestCardFromRegistry(request('login', { message: 'Sign in.', origin: 'https://github.com', fields: [{ ref: '@e3', kind: 'password', label: 'Password' }] }))
    expect(form).toMatchObject({ type: 'login_request' })
    expect(isUnsupportedInChat(form!)).toBe(true)
  })

  it('stays quiet for an auto-approved ask', () => {
    // Nothing is waiting on the user, so "go approve this in the app" would be
    // a lie — the host is already running it.
    expect(requestCardFromRegistry(request('script_run', { script: 'ls' }, { autoApproved: true }))).toBeNull()
  })

  it('stays quiet for agent-scoped app requests', () => {
    expect(requestCardFromRegistry(request('proxy_review', {}, { sessionId: null }))).toBeNull()
    expect(requestCardFromRegistry(request('x_agent_review', {}, { sessionId: null }))).toBeNull()
    expect(requestCardFromRegistry(request('account_reauth_required', {}, { sessionId: null }))).toBeNull()
    expect(requestCardFromRegistry(request('mcp_reauth_required', {}, { sessionId: null }))).toBeNull()
  })

  it('maps every request kind to a decision — no kind can go silent by omission', () => {
    // The regression this guards: before the unified wire, a new kind fell
    // through processSSEEvent's else-if chain and chat users waited on a card
    // that was never coming. Every kind must either render or be one of the
    // documented quiet cases.
    const quiet = new Set(['proxy_review', 'x_agent_review', 'account_reauth_required', 'mcp_reauth_required'])
    for (const kind of USER_INPUT_REQUEST_KINDS) {
      const card = requestCardFromRegistry(request(kind, {}, { sessionId: quiet.has(kind) ? null : 'session-1' }))
      if (quiet.has(kind)) {
        expect(card, kind).toBeNull()
      } else {
        expect(card, kind).not.toBeNull()
      }
    }
  })

  it('gives every rendered kind either an interactive card or a notice a connector can write', () => {
    // A card type with no notice arm and no interactive rendering would post
    // the generic fallback wording, which reads like a bug to the user.
    for (const kind of USER_INPUT_REQUEST_KINDS) {
      const card = requestCardFromRegistry(request(kind, {}, { sessionId: 'session-1' }))
      if (!card) continue
      if (card.type === 'question_request') continue // rendered interactively
      expect(isUnsupportedInChat(card), kind).toBe(true)
      expect(describeUnsupportedRequest(card), kind).not.toContain('request that isn\'t supported in chat')
    }
  })
})

describe('reviewCardFromRegistry', () => {
  it('builds the Allow/Deny card with the id the decision router splits on', () => {
    const card = reviewCardFromRegistry(
      request('proxy_review', { toolkit: 'slack', displayText: 'Post to #general?' }, { id: 'rev-7', sessionId: null }),
    )
    expect(card).toEqual({
      type: 'question_request',
      toolUseId: 'review:rev-7:agent-a',
      questions: [
        {
          question: '🔐 *Slack — Permission Request*\nPost to #general?',
          options: [{ label: '✅ Allow' }, { label: '❌ Deny' }],
        },
      ],
      agentSlug: 'agent-a',
    })
  })

  it('renders an x-agent review the same way', () => {
    const card = reviewCardFromRegistry(
      request('x_agent_review', { displayText: 'Ask Helper Bot to list files?' }, { id: 'rev-8', sessionId: null }),
    )
    expect(card?.toolUseId).toBe('review:rev-8:agent-a')
    expect((card as { questions: Array<{ question: string }> }).questions[0].question).toBe(
      '🔐 *Permission Request*\nAsk Helper Bot to list files?',
    )
  })

  it('returns null for a non-review kind', () => {
    expect(reviewCardFromRegistry(request('secret', { secretName: 'K' }))).toBeNull()
  })

  it('returns null for a review with no agent — the id it would build is unroutable', () => {
    expect(reviewCardFromRegistry(request('proxy_review', {}, { agentSlug: null, sessionId: null }))).toBeNull()
  })
})
