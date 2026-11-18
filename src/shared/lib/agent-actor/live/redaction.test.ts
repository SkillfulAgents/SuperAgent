import { describe, it, expect } from 'vitest'
import { redactStreamedToolInput } from './redaction'

describe('redactStreamedToolInput', () => {
  it('masks the secret in create/update_webhook_endpoint streamed input', () => {
    const input = '{"name":"gh","verification":{"algorithm":"hmac-sha256","secret":"whsec_supersecret","header":"x-sig"}}'
    // The stream carries the MCP-qualified name — that form MUST match, or
    // the redaction never fires on the real path. Bare names also work.
    for (const tool of [
      'mcp__user-input__create_webhook_endpoint',
      'mcp__user-input__update_webhook_endpoint',
      'create_webhook_endpoint',
      'update_webhook_endpoint',
    ]) {
      const out = redactStreamedToolInput(tool, input)
      expect(out).not.toContain('whsec_supersecret')
      expect(out).toContain('"secret":"***"')
      expect(out).toContain('"header":"x-sig"') // other fields untouched
    }
  })

  it('masks a value whose closing quote has not streamed yet', () => {
    const partial = '{"name":"gh","verification":{"secret":"whsec_partial'
    const out = redactStreamedToolInput('create_webhook_endpoint', partial)
    expect(out).not.toContain('whsec_partial')
    expect(out).toContain('"secret":"***')
  })

  it('leaves input for unrelated tools untouched', () => {
    const input = '{"secret":"not-a-webhook-secret"}'
    expect(redactStreamedToolInput('some_other_tool', input)).toBe(input)
    expect(redactStreamedToolInput('mcp__user-input__request_secret', input)).toBe(input)
    expect(redactStreamedToolInput(undefined, input)).toBe(input)
  })
})
