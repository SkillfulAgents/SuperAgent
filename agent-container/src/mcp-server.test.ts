import { describe, it, expect, afterEach } from 'vitest'
import { chatToolList } from './mcp-server'

// The share_dashboard tool is only registered when the host signals (via
// SHARE_DASHBOARD_ENABLED) that the deployment can host a public Telegram Mini
// App. Without a public https URL the tool could only ever degrade to a plain
// text message, so it is omitted entirely rather than exposed and hedged.
describe('chatToolList — share_dashboard capability gate', () => {
  const prev = process.env.SHARE_DASHBOARD_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.SHARE_DASHBOARD_ENABLED
    else process.env.SHARE_DASHBOARD_ENABLED = prev
  })

  it('includes share_dashboard when SHARE_DASHBOARD_ENABLED=true', () => {
    process.env.SHARE_DASHBOARD_ENABLED = 'true'
    expect(chatToolList().map((t) => t.name)).toContain('share_dashboard')
  })

  it('omits share_dashboard when the flag is unset, keeping the other chat tools', () => {
    delete process.env.SHARE_DASHBOARD_ENABLED
    const names = chatToolList().map((t) => t.name)
    expect(names).not.toContain('share_dashboard')
    expect(names).toContain('send_chat_message')
    expect(names).toContain('list_chat_integrations')
  })
})
