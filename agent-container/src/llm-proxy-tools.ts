type Json = Record<string, unknown>
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined

/** Claude Code performs ToolSearch locally. Its result references schemas in
 * this same request; third-party APIs need their readable definitions instead.
 * Keep unloaded tools deferred, without a cross-request/account schema cache.
 */
export function expandDeferredTools(body: Json): Json {
  const tools = Array.isArray(body.tools) ? body.tools.map(object).filter(t => !!t) : []
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const loaded = new Set<unknown>()
  function content(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    return value.map(raw => {
      const block = object(raw)
      if (!block) return raw
      if (block.type === 'tool_use') loaded.add(block.name)
      if (block.type === 'tool_reference') {
        loaded.add(block.tool_name)
        const tool = byName.get(block.tool_name)
        return { type: 'text', text: JSON.stringify({
          name: block.tool_name ?? 'unknown',
          description: tool?.description ?? '',
          parameters: tool?.input_schema ?? {},
        }) }
      }
      return block.type === 'tool_result' ? { ...block, content: content(block.content) } : raw
    })
  }
  const messages = Array.isArray(body.messages) ? body.messages.map(raw => {
    const message = object(raw)
    return message ? { ...message, content: content(message.content) } : raw
  }) : body.messages
  return { ...body, messages, ...(Array.isArray(body.tools) ? {
    tools: tools.filter(tool => !tool.defer_loading || loaded.has(tool.name)).map(tool => {
      const definition = { ...tool }
      delete definition.defer_loading
      return definition
    }),
  } : {}) }
}
