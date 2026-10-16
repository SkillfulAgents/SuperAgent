type Json = Record<string, unknown>

/** Grok always reasons; helpers that disable thinking use its lowest effort. */
export function normalizeGrokResponses(body: Json): Json {
  const reasoning = body.reasoning as Json | undefined
  const normalized = reasoning?.effort === 'none'
    ? { ...body, reasoning: { ...reasoning, effort: 'low' } }
    : body
  return Array.isArray(normalized.input) ? { ...normalized, input: normalized.input.map(withoutFileParts) } : normalized
}

// The Grok subscription endpoint is zero-data-retention and rejects any input_file
// part with a 400, which also poisons every later turn that replays the history.
function withoutFileParts(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item
  const record = item as Json
  if (Array.isArray(record.content)) return { ...record, content: record.content.map(fileToNote) }
  if (Array.isArray(record.output)) return { ...record, output: record.output.map(fileToNote) }
  return item
}

function fileToNote(part: unknown): unknown {
  if (!part || typeof part !== 'object' || (part as Json).type !== 'input_file') return part
  const filename = (part as Json).filename
  const name = typeof filename === 'string' && filename ? `"${filename}"` : 'file'
  return { type: 'input_text', text: `[Attached ${name} was not sent: this Grok subscription does not accept file input. Extract its text with a tool, e.g. pdftotext.]` }
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
