import { describe, it, expect } from 'vitest'
import { planMcpOAuthCallback, parseMcpOAuthCompletionResponse } from './mcp-oauth-callback'

describe('planMcpOAuthCallback', () => {
  it('completes against the cloud proxy base URL when the cloud target is active (SUP-560)', () => {
    const plan = planMcpOAuthCallback(
      'superagent://mcp-oauth-callback?code=abc&state=xyz',
      'http://localhost:4823/cloud/pr0xy-k3y',
    )
    expect(plan).toEqual({
      action: 'complete',
      completionUrl:
        'http://localhost:4823/cloud/pr0xy-k3y/api/remote-mcps/oauth-callback?code=abc&state=xyz',
    })
  })

  it('completes against the local API when the local target is active', () => {
    const plan = planMcpOAuthCallback(
      'superagent://mcp-oauth-callback?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example.com',
      'http://localhost:4823',
    )
    expect(plan).toEqual({
      action: 'complete',
      completionUrl:
        'http://localhost:4823/api/remote-mcps/oauth-callback?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example.com',
    })
  })

  it('notifies directly when the hand-off page already carries a success result', () => {
    const plan = planMcpOAuthCallback(
      'superagent://mcp-oauth-callback?success=true&mcpId=mcp-1',
      'http://localhost:4823/cloud/pr0xy-k3y',
    )
    expect(plan).toEqual({
      action: 'notify',
      result: { success: true, mcpId: 'mcp-1', error: null },
    })
  })

  it('notifies a failure with the carried error when success=false', () => {
    const plan = planMcpOAuthCallback(
      'superagent://mcp-oauth-callback?success=false&error=Token%20exchange%20failed',
      'http://localhost:4823',
    )
    expect(plan).toEqual({
      action: 'notify',
      result: { success: false, mcpId: null, error: 'Token exchange failed' },
    })
  })

  it('returns null for an unparseable callback URL', () => {
    expect(planMcpOAuthCallback('not a url', 'http://localhost:4823')).toBeNull()
  })
})

describe('parseMcpOAuthCompletionResponse', () => {
  it('reads success and mcpId from the callback page JSON payload', () => {
    const html = `
      <html><body><script>
        const payload = {"type":"mcp-oauth-callback","success":true,"mcpId":"mcp-new"};
      </script><p>OAuth successful! You can close this window.</p></body></html>
    `
    expect(parseMcpOAuthCompletionResponse(html)).toEqual({
      success: true,
      mcpId: 'mcp-new',
      error: null,
    })
  })

  it('reports failure when the page does not announce success', () => {
    const html = '<html><body><p>OAuth failed. You can close this window.</p></body></html>'
    expect(parseMcpOAuthCompletionResponse(html)).toEqual({
      success: false,
      mcpId: null,
      error: 'OAuth failed',
    })
  })
})
