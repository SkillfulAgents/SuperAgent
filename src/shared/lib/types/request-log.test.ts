import { describe, expect, it } from 'vitest'
import { requestLogPageSchema } from './request-log'

const validPage = {
  entries: [{
    id: 'request-1',
    source: 'proxy',
    agentSlug: 'research-agent',
    label: 'github',
    targetUrl: 'https://api.github.com/repos/openai/codex',
    method: 'GET',
    statusCode: 200,
    errorMessage: null,
    durationMs: 42,
    policyDecision: 'allow',
    matchedScopes: '["repo.read"]',
    createdAt: '2026-07-20T12:00:00.000Z',
  }],
  total: 1,
}

describe('requestLogPageSchema', () => {
  it('accepts the request-log transport shape', () => {
    expect(requestLogPageSchema.parse(validPage)).toEqual(validPage)
  })

  it('rejects a response with an invalid entry shape', () => {
    expect(() => requestLogPageSchema.parse({
      ...validPage,
      entries: [{ ...validPage.entries[0], statusCode: '200' }],
    })).toThrow()
  })
})
