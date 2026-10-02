type Json = Record<string, unknown>

/** Grok always reasons; helpers that disable thinking use its lowest effort. */
export function normalizeGrokResponses(body: Json): Json {
  const reasoning = body.reasoning as Json | undefined
  return reasoning?.effort === 'none'
    ? { ...body, reasoning: { ...reasoning, effort: 'low' } }
    : body
}

/** Grok's subscription proxy rejects clients below its minimum version with a 426 that names the minimum. */
export function grokMinimumClientVersion(body: string): string | undefined {
  return /update to version (\d+(?:\.\d+)+) or later/i.exec(body)?.[1]
}

/** Sends with the current client version. When Grok raises its minimum, adopts
 * the version the 426 names and resends once, so a stale pin heals itself.
 */
export async function withGrokClientVersion(version: { current: string }, send: (version: string) => Promise<Response>): Promise<Response> {
  const response = await send(version.current)
  if (response.status !== 426) return response
  const minimum = grokMinimumClientVersion(await response.clone().text())
  if (!minimum || minimum === version.current) return response
  await response.body?.cancel()
  version.current = minimum
  return send(minimum)
}
