export interface McpOAuthCallbackResult {
  success: boolean
  mcpId: string | null
  error: string | null
}

export type McpOAuthCallbackPlan =
  // http-loopback path: the API server already completed the token exchange in
  // the external browser and bounced the finished result back via deep link.
  | { action: 'notify'; result: McpOAuthCallbackResult }
  // Custom-scheme path: the app received the raw code/state, so the token
  // exchange still has to run — against the Superagent that initiated the flow.
  | { action: 'complete'; completionUrl: string }

/**
 * Decide how to handle an mcp-oauth-callback deep link. `apiBaseUrl` must be
 * the *active* target's base URL: with the Cloud toggle on, the pending OAuth
 * state lives in the cloud deployment's memory, so completing against the
 * local API is guaranteed to miss it (SUP-560).
 */
export function planMcpOAuthCallback(
  deepLinkUrl: string,
  apiBaseUrl: string,
): McpOAuthCallbackPlan | null {
  let callbackUrl: URL
  try {
    callbackUrl = new URL(deepLinkUrl)
  } catch {
    return null
  }
  const params = callbackUrl.searchParams

  if (params.has('success')) {
    const success = params.get('success') === 'true'
    return {
      action: 'notify',
      result: {
        success,
        mcpId: params.get('mcpId') || null,
        error: success ? null : (params.get('error') || 'OAuth failed'),
      },
    }
  }

  return {
    action: 'complete',
    completionUrl: `${apiBaseUrl}/api/remote-mcps/oauth-callback${callbackUrl.search}`,
  }
}

/** Read the completion result out of the callback route's HTML response. */
export function parseMcpOAuthCompletionResponse(html: string): McpOAuthCallbackResult {
  const success = html.includes('OAuth successful')
  // The callback page embeds the result payload as JSON; the single-quote form
  // is kept for older servers that inlined it as a JS object literal.
  const mcpIdMatch = html.match(/"mcpId":"([^"]+)"/) ?? html.match(/mcpId:\s*'([^']+)'/)
  return {
    success,
    mcpId: mcpIdMatch?.[1] || null,
    error: success ? null : 'OAuth failed',
  }
}
