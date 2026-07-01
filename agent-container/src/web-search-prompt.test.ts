import { describe, it, expect } from 'vitest'
import { resolveWebSearchToolInPrompt } from './web-search-prompt'

const CATALOG_LINE =
  '- **File system, shell, web** — `Read` / `Write` / `Edit` / `Bash` / `WebFetch` / `WebSearch`. The standard agent core.'

describe('resolveWebSearchToolInPrompt', () => {
  it('keeps the native WebSearch tool named when no vendor is active', () => {
    const out = resolveWebSearchToolInPrompt(CATALOG_LINE, undefined)
    expect(out).toContain('`WebSearch`')
    expect(out).not.toContain('mcp__web__web_search')
  })

  it('names the in-container MCP tool when a host vendor is active', () => {
    const out = resolveWebSearchToolInPrompt(CATALOG_LINE, 'exa')
    expect(out).toContain('`mcp__web__web_search`')
    expect(out).not.toContain('`WebSearch`')
  })
})
