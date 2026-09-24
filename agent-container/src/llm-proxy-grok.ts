type Json = Record<string, unknown>

/** Grok always reasons; helpers that disable thinking use its lowest effort. */
export function normalizeGrokResponses(body: Json): Json {
  const reasoning = body.reasoning as Json | undefined
  return reasoning?.effort === 'none'
    ? { ...body, reasoning: { ...reasoning, effort: 'low' } }
    : body
}
