import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../config/settings', () => ({ getSettings: () => settings.current }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'platform-token' }))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.example.test' }))

import { decide, getDecisionProvider, type DecisionRequest } from './index'

const request: DecisionRequest = {
  state: { customer_tier: 'enterprise', ticket: 'My checkout page shows a blank screen after I click Pay.' },
  questions: {
    is_bug: { type: 'yesno', instructions: 'Is the customer reporting a software defect?' },
    team: {
      type: 'choice',
      instructions: 'Which team should own this ticket?',
      options: { payments: 'Checkout and billing issues.', frontend: 'Rendering issues.' },
    },
    urgency: { type: 'score', instructions: 'How urgent is this ticket?', levels: ['Can wait', 'This week', 'Blocking revenue'] },
  },
}

const systemOneQuestions = {
  is_bug: { type: 'noul', instructions: 'Is the customer reporting a software defect?' },
  team: {
    type: 'choice',
    instructions: 'Which team should own this ticket?',
    criteria: { payments: 'Checkout and billing issues.', frontend: 'Rendering issues.' },
  },
  urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['Can wait', 'This week', 'Blocking revenue'] },
}

const systemOneAnswers = {
  is_bug: { type: 'noul', noul: 0.96 },
  team: { type: 'choice', choice: 'payments', confidence: 0.67, probabilities: { payments: 0.78, frontend: 0.22 } },
  urgency: { type: 'score', score: 1.99, confidence: 0.99, probabilities: { 0: 0, 1: 0.01, 2: 0.99 } },
}

const normalized = {
  is_bug: { type: 'yesno', probability: 0.96 },
  team: { type: 'choice', choice: 'payments', confidence: 0.67, probabilities: { payments: 0.78, frontend: 0.22 } },
  urgency: { type: 'score', score: 1.99, confidence: 0.99, probabilities: [0, 0.01, 0.99] },
}

const calls: Array<{ url: string; auth: string | null; body: unknown }> = []

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }))
}

beforeEach(() => {
  calls.length = 0
  settings.current = { apiKeys: { typesafeApiKey: 'ts-key', cloudflareApiToken: 'cf-token', cloudflareAccountId: 'acct-1', openaiApiKey: 'oai-key' } }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TypeSafe', () => {
  it('sends System One to the TypeSafe API and normalizes the answers', async () => {
    respond(200, { model: 'jev-1.13.0', answers: systemOneAnswers, usage: { input_tokens: 296, output_tokens: 20 } })

    const result = await getDecisionProvider('typesafe').decide(request)

    expect(calls).toEqual([{
      url: 'https://api.typesafe.ai/v1/systemone',
      auth: 'Bearer ts-key',
      body: { model: 'jev-latest', state: request.state, questions: systemOneQuestions },
    }])
    expect(result).toEqual(normalized)
  })
})

describe('Cloudflare', () => {
  it('calls the Workers AI model URL and unwraps the result envelope', async () => {
    respond(200, { result: { answers: systemOneAnswers }, success: true, errors: [], messages: [] })

    const result = await getDecisionProvider('cloudflare').decide(request)

    expect(calls).toEqual([{
      url: 'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef',
      auth: 'Bearer cf-token',
      body: { model: 'clef', state: request.state, questions: systemOneQuestions },
    }])
    expect(result).toEqual(normalized)
  })

  it('is not configured without an account ID', () => {
    settings.current = { apiKeys: { cloudflareApiToken: 'cf-token' } }

    expect(getDecisionProvider('cloudflare').getApiKeyStatus().isConfigured).toBe(false)
  })
})

describe('OpenAI', () => {
  it('sends named questions with the state as text and normalizes the answers', async () => {
    respond(200, {
      answers: [
        { type: 'predicate', name: 'is_bug', probability: 0.92 },
        {
          type: 'choice',
          name: 'team',
          choice: 'payments',
          probabilities: [{ value: 'payments', probability: 0.95 }, { value: 'frontend', probability: 0.05 }],
          confidence: 0.93,
        },
        {
          type: 'score',
          name: 'urgency',
          score: 1.1,
          probabilities: [
            { value: 0, label: 'Can wait', probability: 0.1 },
            { value: 1, label: 'This week', probability: 0.7 },
            { value: 2, label: 'Blocking revenue', probability: 0.2 },
          ],
          confidence: 0.55,
        },
      ],
    })

    const result = await getDecisionProvider('openai').decide(request)

    expect(calls).toEqual([{
      url: 'https://api.openai.com/v1/decisions',
      auth: 'Bearer oai-key',
      body: {
        model: 'gpt-6-luna',
        input: JSON.stringify(request.state),
        questions: [
          { type: 'predicate', name: 'is_bug', instructions: 'Is the customer reporting a software defect?' },
          {
            type: 'choice',
            name: 'team',
            instructions: 'Which team should own this ticket?',
            choices: [
              { value: 'payments', description: 'Checkout and billing issues.' },
              { value: 'frontend', description: 'Rendering issues.' },
            ],
          },
          {
            type: 'score',
            name: 'urgency',
            instructions: 'How urgent is this ticket?',
            levels: [{ label: 'Can wait' }, { label: 'This week' }, { label: 'Blocking revenue' }],
          },
        ],
      },
    }])
    expect(result).toEqual({
      is_bug: { type: 'yesno', probability: 0.92 },
      team: { type: 'choice', choice: 'payments', confidence: 0.93, probabilities: { payments: 0.95, frontend: 0.05 } },
      urgency: { type: 'score', score: 1.1, confidence: 0.55, probabilities: [0.1, 0.7, 0.2] },
    })
  })

  it('keeps a refusal as refused instead of probability 0', async () => {
    respond(200, { answers: [{ type: 'refusal', name: 'is_bug' }] })

    const result = await getDecisionProvider('openai').decide({ ...request, questions: { is_bug: request.questions.is_bug } })

    expect(result).toEqual({ is_bug: { type: 'refused' } })
  })
})

describe('Platform', () => {
  it('sends the OpenAI request to the platform proxy with the platform token', async () => {
    respond(200, { answers: [{ type: 'predicate', name: 'is_bug', probability: 0.9 }] })

    const result = await getDecisionProvider('platform').decide({ ...request, questions: { is_bug: request.questions.is_bug } })

    expect(calls.map(call => [call.url, call.auth, (call.body as { model: string }).model])).toEqual([
      ['https://proxy.example.test/v1/openai/decisions', 'Bearer platform-token', 'gpt-6-luna'],
    ])
    expect(result).toEqual({ is_bug: { type: 'yesno', probability: 0.9 } })
  })
})

describe('decide', () => {
  it('uses the selected provider and its model', async () => {
    settings.current = { ...settings.current, decision: { provider: 'typesafe' } }
    respond(200, { answers: systemOneAnswers })

    await decide(request)

    expect(calls.map(call => [call.url, (call.body as { model: string }).model])).toEqual([
      ['https://api.typesafe.ai/v1/systemone', 'jev-latest'],
    ])
  })

  it('throws when no decision model is selected', async () => {
    await expect(decide(request)).rejects.toThrow('No decision model configured.')
  })

  it('throws when a question comes back without an answer', async () => {
    respond(200, { answers: { is_bug: { type: 'noul', noul: 0.4 } } })

    await expect(getDecisionProvider('typesafe').decide(request)).rejects.toThrow('missing answers for: team, urgency')
  })

  it('does not retry a rejected request', async () => {
    respond(400, { error: { message: 'Unknown model' } })

    await expect(getDecisionProvider('typesafe').decide(request)).rejects.toThrow('TypeSafe decision request failed (400)')
    expect(calls).toHaveLength(1)
  })
})
