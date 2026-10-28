import { XAgentError, textResult } from '../agents/host-client'

export { XAgentError, textResult }

export async function callChatHost<T>(
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
  const url = `${baseUrl.replace(/\/$/, '')}/x-agent/chat/${op}`
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
    throw new XAgentError(0, `Network error calling x-agent chat/${op}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    let errorBody: { error?: string } = {}
    try {
      errorBody = (await response.json()) as { error?: string }
    } catch {
      // ignore
    }
    throw new XAgentError(response.status, errorBody.error ?? `x-agent chat/${op} failed (HTTP ${response.status})`)
  }
  return (await response.json()) as T
}
