// Tool inputs whose streamed JSON may carry an HMAC signing secret in a
// `secret` field. That secret is a shared credential (anyone holding it can
// forge signed webhooks), so it must never render in the live transcript or
// go out on a session stream. The SDK still persists the raw tool_use to the
// container's transcript; that is agent-supplied and container-local. This
// masks the one path the host controls: the stream to clients.
const SECRET_BEARING_TOOL_NAMES = new Set([
  'create_webhook_endpoint',
  'update_webhook_endpoint',
])

/**
 * Mask the value of a `secret` field in (possibly still-streaming) tool-input
 * JSON. Idempotent across deltas: the whole accumulated buffer is re-masked
 * each time, and a value whose closing quote hasn't streamed yet is masked as
 * far as it has arrived.
 */
export function redactStreamedToolInput(toolName: string | undefined, partialInput: string): string {
  if (!toolName) return partialInput
  // MCP tools stream under their qualified name (`mcp__<server>__<tool>`);
  // match on the bare name so the list can't silently miss the wire format.
  const bareName = toolName.startsWith('mcp__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName
  if (!SECRET_BEARING_TOOL_NAMES.has(bareName)) return partialInput
  // Replace the JSON string value after `"secret":"` with `***`, stopping at
  // the (unescaped) closing quote, which is left intact when present.
  return partialInput.replace(/("secret"\s*:\s*")(?:\\.|[^"\\])*/g, '$1***')
}
