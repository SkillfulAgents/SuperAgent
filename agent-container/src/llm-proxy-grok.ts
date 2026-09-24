type Json = Record<string, unknown>
const record = (v: unknown): Json | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined

/** Targeted fixes for Grok's Messages compatibility endpoint. */
export function normalizeGrokMessages(body: Json): Json {
  const system: unknown[] = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? [...body.system] : []
  const messages: Json[] = []
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(raw)
    if (!message) continue
    if (message.role === 'system') {
      system.push(...(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []))
      continue
    }
    if (!Array.isArray(message.content)) { messages.push(message); continue }
    const images: unknown[] = []
    const content = message.content.flatMap(rawBlock => {
      const block = record(rawBlock)
      if (!block) return [rawBlock]
      if (block.type === 'thinking' || block.type === 'redacted_thinking') return []
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return [block]
      const inner = block.content.map(part => {
        if (record(part)?.type !== 'image') return part
        images.push(part)
        return { type: 'text', text: '[Image attached below.]' }
      })
      return [{ ...block, content: inner }]
    })
    if (content.length || images.length) messages.push({ ...message, content: [...content, ...images] })
  }
  const tools = Array.isArray(body.tools) ? body.tools.map(raw => {
    const tool = record(raw)
    return tool?.input_schema ? { ...tool, input_schema: normalizeSchema(tool.input_schema) } : raw
  }) : body.tools
  return { ...body, ...(system.length || body.system !== undefined ? { system } : {}), messages, ...(tools ? { tools } : {}) }
}
function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  const schema = record(value)
  if (!schema) return value
  const result: Json = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, normalizeSchema(v)]))
  if (result.type === 'object' && !Array.isArray(result.required)) result.required = []
  return result
}
export function grokWireFormat(body: Json): 'messages' | 'responses' {
  // Claude Code's native WebSearch makes a separate hosted-tool request. Grok
  // exposes that tool on Responses, while ordinary agent turns stay Messages.
  return Array.isArray(body.tools) && body.tools.some(t => String(record(t)?.type).startsWith('web_search')) ? 'responses' : 'messages'
}
