import { describe, it, expect } from 'vitest'
import { resolveWebFetchToolInPrompt } from './web-fetch-prompt'

const CATALOG_LINE =
  '- **File system, shell, web** — `Read` / `Write` / `Edit` / `Bash` / `WebFetch` / `WebSearch`. The standard agent core.'

describe('resolveWebFetchToolInPrompt', () => {
  it('keeps the native WebFetch tool named when no vendor is active', () => {
    const out = resolveWebFetchToolInPrompt(CATALOG_LINE, undefined)
    expect(out).toContain('`WebFetch`')
    expect(out).not.toContain('mcp__web__web_fetch')
  })

  it('names the in-container MCP tool when a host vendor is active', () => {
    const out = resolveWebFetchToolInPrompt(CATALOG_LINE, 'exa')
    expect(out).toContain('`mcp__web__web_fetch`')
    expect(out).not.toContain('`WebFetch`')
  })

  it('leaves WebSearch untouched (only swaps the WebFetch token)', () => {
    const out = resolveWebFetchToolInPrompt(CATALOG_LINE, 'exa')
    expect(out).toContain('`WebSearch`')
  })
})
