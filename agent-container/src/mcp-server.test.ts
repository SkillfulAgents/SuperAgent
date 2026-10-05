import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    createSdkMcpServer: (options: { name: string; tools?: Array<{ name: string }> }) => ({
      type: 'sdk',
      name: options.name,
      instance: { toolNames: (options.tools ?? []).map((t) => t.name) },
    }),
  }
})

import { createUserInputMcpServer } from './mcp-server'

function toolNames(server: ReturnType<typeof createUserInputMcpServer>): string[] {
  return (server.instance as unknown as { toolNames: string[] }).toolNames
}

const KEYS = ['HOST_PLATFORM', 'COMPOSIO_PLATFORM_MODE', 'PLATFORM_AUTH_ACTIVE']
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]!
  }
})

describe('createUserInputMcpServer', () => {
  it('offers notify_user only in a noninteractive session', () => {
    expect(toolNames(createUserInputMcpServer())).not.toContain('notify_user')
    expect(toolNames(createUserInputMcpServer(() => null, {}))).not.toContain('notify_user')
    expect(toolNames(createUserInputMcpServer(() => null, { noninteractive: false }))).not.toContain('notify_user')
    expect(toolNames(createUserInputMcpServer(() => null, { noninteractive: true }))).toContain('notify_user')
  })

  it('keeps the rest of the tool set identical across modes', () => {
    const interactive = toolNames(createUserInputMcpServer(() => null, { noninteractive: false }))
    const unattended = toolNames(createUserInputMcpServer(() => null, { noninteractive: true }))
    expect(unattended.filter((n) => n !== 'notify_user')).toEqual(interactive)
    expect(interactive).toEqual(expect.arrayContaining(['request_secret', 'schedule_resume', 'request_file']))
  })
})
