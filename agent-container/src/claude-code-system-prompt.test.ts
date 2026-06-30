import { describe, it, expect, vi, afterEach } from 'vitest'

// The SDK is imported by claude-code at module load; stub it so importing the
// module under test doesn't pull in real SDK behaviour.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: (name: string) => ({ name }),
  createSdkMcpServer: vi.fn(() => ({})),
}))

import { generateSystemPrompt } from './claude-code'

// When the deployment can't host a Telegram Mini App, the agent has no
// share_dashboard tool. Without guidance it would flail or falsely claim it
// shared a dashboard; this note tells it the honest thing to say instead. It
// must appear ONLY when the tool is absent (SHARE_DASHBOARD_ENABLED !== 'true'),
// mirroring the host-side tool gate.
const NOTE_HEADING = 'Sharing dashboards to chat'

describe('generateSystemPrompt — dashboard-share capability note', () => {
  const prev = process.env.SHARE_DASHBOARD_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.SHARE_DASHBOARD_ENABLED
    else process.env.SHARE_DASHBOARD_ENABLED = prev
  })

  it('includes the note when share_dashboard is unavailable (flag unset)', () => {
    delete process.env.SHARE_DASHBOARD_ENABLED
    const prompt = generateSystemPrompt()
    expect(prompt).toContain(NOTE_HEADING)
    expect(prompt).toContain('do not claim you did it')
  })

  it('omits the note when share_dashboard is available (flag=true)', () => {
    process.env.SHARE_DASHBOARD_ENABLED = 'true'
    const prompt = generateSystemPrompt()
    expect(prompt).not.toContain(NOTE_HEADING)
  })
})
