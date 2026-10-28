import { XAgentError, textResult } from '../agents/host-client'

export { XAgentError, textResult }

// `resource` is the host route segment ('web-search' | 'web-fetch'); `op` is the endpoint under it
// ('search' | 'fetch'). Parametrized (not hardcoded to web-search) so each web RPC targets its own
// dedicated host route, e.g. callWebHost('web-fetch', 'fetch', ...) -> /web-fetch/fetch.
export async function callWebHost<T>(
  resource: string,
  op: string,
  body: Record<string, unknown>,
): Promise<T> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  if (!baseUrl) {
    throw new XAgentError(500, 'SUPERAGENT_HOST_API_URL not set')
  }
  if (!token) {
    throw new XAgentError(500, 'PROXY_TOKEN not set')
  }
  const url = `${baseUrl.replace(/\/$/, '')}/${resource}/${op}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new XAgentError(0, `Network error calling ${resource}/${op}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    let errorBody: { error?: string } = {}
    try {
      errorBody = (await response.json()) as { error?: string }
    } catch {
      // ignore
    }
    throw new XAgentError(response.status, errorBody.error ?? `${resource}/${op} failed (HTTP ${response.status})`)
  }
  return (await response.json()) as T
}
