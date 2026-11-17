import type { APIRequestContext } from '@playwright/test'

/**
 * What the app keeps about each of an agent's sessions: names, stars and how
 * each was started. Most of it is not projected into the session API, so a
 * spec that asserts on provenance reads the agent's session index through the
 * debug route. An agent the server does not know yet reads as no sessions,
 * for the caller's poll to retry.
 */
export async function readSessionMetadata(
  request: APIRequestContext,
  agentSlug: string,
): Promise<Record<string, Record<string, unknown>>> {
  const response = await request.get(`/api/debug/agents/${agentSlug}/session-metadata`)
  if (response.status() === 404) return {}
  if (!response.ok()) throw new Error(`Reading session metadata of ${agentSlug} failed: ${response.status()}`)
  return response.json()
}
