import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { listAgentIntegrationsTool } from '../integrations/list-agent-integrations'
import { makeSendChatMessageTool } from './send-chat-message'
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

it('explains that an empty email history does not prevent a new email', async () => {
  host({ provider: 'platform-email', channels: [], truncated: false })
  const result = await (listChatChannelsTool as unknown as Callable).execute({ integration_id: 'email' })
  expect(result.content[0].text).toContain('No existing conversation is required')
  expect(result.content[0].text).toContain('email.to')
})

it('preserves provider-specific instructions returned by integration discovery', async () => {
  host({ integrations: [{ id: 'email', provider: 'platform-email', family: 'email', name: 'Agent', status: 'active', capabilities: ['send_email'], sessions: [], mcp: null, instructions: 'Use email.to for a new email; no existing conversation required.' }] })
  const result = await (listAgentIntegrationsTool as unknown as { execute(input: object): Promise<{ content: { text: string }[] }> }).execute({})
  expect(JSON.parse(result.content[0].text).integrations[0].instructions).toContain('Use email.to')
})
it('forwards structured email fields and identifies acceptance without claiming delivery', async () => {
  host({ chatId: 'thread', provider: 'platform-email', messageId: 'message', status: 'queued' })
  const tool = makeSendChatMessageTool(() => 'caller-session') as unknown as { execute(input: object): Promise<{ content: { text: string }[] }> }
  const email = { to: ['a@example.com'], subject: 'Hello', idempotency_key: 'hello-test' }
  const result = await tool.execute({ integration_id: 'email', message: 'Hello, world!', email })
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ email, message: 'Hello, world!', session_id: 'caller-session' })
  expect(result.content[0].text).toContain('Status: queued')
  expect(result.content[0].text).not.toContain('delivered')
})
