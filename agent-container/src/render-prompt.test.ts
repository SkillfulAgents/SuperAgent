import { describe, it, expect } from 'vitest'
import { renderPrompt } from './render-prompt'

describe('renderPrompt', () => {
  it('interpolates <% %> tags and inserts raw (no HTML escaping)', () => {
    const out = renderPrompt('tool: `<%name%>` path: <%dir%>', { name: 'A & B', dir: '/x/<y>' })
    expect(out).toBe('tool: `A & B` path: /x/<y>')
  })
  it('leaves literal {{ }} content untouched', () => {
    const out = renderPrompt('name: {{short-kebab-case-slug}} val: <%v%>', { v: '1' })
    expect(out).toBe('name: {{short-kebab-case-slug}} val: 1')
  })
  it('renders a section when its flag is true and drops it when false', () => {
    const tpl = 'a\n<%#on%>\nSECTION\n<%/on%>\nb'
    expect(renderPrompt(tpl, { on: true })).toContain('SECTION')
    expect(renderPrompt(tpl, { on: false })).not.toContain('SECTION')
  })
  it('never re-parses template syntax inside an interpolated value (injection-safe)', () => {
    // A value carrying `<% %>` or `{{ }}` must land as literal text, not be
    // evaluated as a tag - guards against a future var whose content is
    // attacker- or user-controlled.
    const out = renderPrompt('<%v%>', { v: '<%injected%> {{also}}', injected: 'BAD', also: 'BAD' })
    expect(out).toBe('<%injected%> {{also}}')
  })
})
