import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { listChatUsersTool } from './list-chat-users'
import { listChatChannelsTool } from './list-chat-channels'
type Callable = { execute(input: { integration_id: string }): Promise<{ content: { text: string }[] }> }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function host(body: unknown) {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
}
it('renders email addresses and contact sources instead of unusable user IDs', async () => {
  host({ provider: 'platform-email', users: [{ id: 'a@example.com', email: 'a@example.com', name: 'Alice', source: 'workspace' }], truncated: true })
  const result = await (listChatUsersTool as unknown as Callable).execute({ integration_id: 'email' })
  expect(result.content[0].text).toContain('email: a@example.com (workspace)')
  expect(result.content[0].text).not.toContain('user_id:')
  expect(result.content[0].text).toContain('truncated')
})
it('renders reply message IDs and allowed participants for email conversations', async () => {
  host({ provider: 'platform-email', channels: [{ id: 'thread', name: 'Report', replyToMessageId: 'message', participants: ['a@example.com'] }], truncated: false })
  const result = await (listChatChannelsTool as unknown as Callable).execute({ integration_id: 'email' })
  expect(result.content[0].text).toContain('email.reply_to_message_id: message')
  expect(result.content[0].text).toContain('participants: a@example.com')
  expect(result.content[0].text).not.toContain('chat_id:')
})
it('preserves Slack user and channel discovery', async () => {
  host({ provider: 'slack', users: [{ id: 'U1', name: 'Alice' }], truncated: false })
  expect((await (listChatUsersTool as unknown as Callable).execute({ integration_id: 'slack' })).content[0].text).toContain('user_id: U1')
  host({ provider: 'slack', channels: [{ id: 'C1', name: '#general' }], truncated: false })
  expect((await (listChatChannelsTool as unknown as Callable).execute({ integration_id: 'slack' })).content[0].text).toContain('chat_id: C1')
})
