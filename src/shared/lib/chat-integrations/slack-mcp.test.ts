import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIntegrationRecord } from '../agent-integrations/types'

const manager = vi.hoisted(() => ({ getConnector: vi.fn() }))
vi.mock('../agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: manager }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('./chat-input', async (importOriginal) => ({ ...(await importOriginal<typeof import('./chat-input')>()), downloadSlackUrl: vi.fn() }))
const actor = vi.hoisted(() => ({ readSized: vi.fn(), write: vi.fn(async () => ({ size: 0 })) }))
vi.mock('../agent-actor', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agent-actor')>()), agentRegistry: { get: () => ({ files: { readSized: actor.readSized, write: actor.write } }) } }))

import { slackMcpConnection } from './slack-mcp'
import { SlackConnector } from './slack-connector'
import { downloadSlackUrl } from './chat-input'
import { LocalFileOps } from '../agent-actor/local-file-ops'
import { mkdtempSync, symlinkSync, writeFileSync as writeFileSyncNode } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFileError } from '../agent-actor'
import { readFileSync } from 'node:fs'
import { BOT_SCOPES } from './slack-manifest'

const record = { id: 'int-1', agentSlug: 'agent', name: 'Helper', provider: 'slack', status: 'active' } as AgentIntegrationRecord
const platformError = (error: string) => Object.assign(new Error(error), { code: 'slack_webapi_platform_error', data: { error } })

function connectorWith(client: Record<string, unknown>) {
  const connector = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' })
  ;(connector as any).app = { client: { users: { info: vi.fn(async ({ user }) => ({ user: { id: user, real_name: user === 'U1' ? 'Ada' : 'Bo' } })) }, ...client } }
  return connector
}

async function call(name: string, args: Record<string, unknown>) {
  const response = await slackMcpConnection(record).serve!(new Request('https://slack.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }))
  return { status: response.status, body: response.status === 200 ? await response.json() : null }
}
const text = (body: any) => body.result.content[0].text as string

beforeEach(() => { manager.getConnector.mockReset() })

describe('Slack MCP', () => {
  it('advertises the tools it serves', async () => {
    manager.getConnector.mockReturnValue(connectorWith({}))
    const response = await slackMcpConnection(record).serve!(new Request('https://slack.com/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }))
    const listed = (await response.json()).result.tools.map((t: { name: string }) => t.name)
    expect(listed).toEqual(slackMcpConnection(record).tools.map(t => t.name))
    expect(listed).toEqual([
      'slack_read_channel', 'slack_read_thread', 'slack_read_conversation_info', 'slack_list_channel_members', 'slack_read_user_profile',
      'slack_get_permalink', 'slack_add_reaction', 'slack_send_ephemeral', 'slack_schedule_message', 'slack_edit_message', 'slack_delete_message',
      'slack_get_reactions', 'slack_list_emoji', 'slack_pin_message', 'slack_unpin_message', 'slack_add_bookmark', 'slack_create_canvas', 'slack_read_canvas',
      'slack_edit_canvas', 'slack_read_list', 'slack_add_list_item', 'slack_join_channel', 'slack_create_channel', 'slack_set_topic',
      'slack_remove_reaction', 'slack_list_pins', 'slack_list_bookmarks', 'slack_remove_bookmark', 'slack_list_scheduled_messages',
      'slack_delete_scheduled_message', 'slack_invite_to_channel', 'slack_set_purpose', 'slack_list_user_groups', 'slack_get_presence', 'slack_read_file',
      'slack_upload_file', 'slack_delete_canvas',
    ])
  })

  it('reads the channel of a thread oldest first, with senders, message ids, threads and the earlier page', async () => {
    const history = vi.fn(async () => ({
      messages: [{ ts: '1793992200.000200', user: 'U2', text: 'later' }, { ts: '1793992100.000100', user: 'U1', text: 'first', reply_count: 2 }],
      response_metadata: { next_cursor: 'abc' },
    }))
    manager.getConnector.mockReturnValue(connectorWith({ conversations: { history } }))

    const { body } = await call('slack_read_channel', { conversation: 'C1|1793992100.000100' })

    expect(history).toHaveBeenCalledWith({ channel: 'C1', limit: 50, cursor: undefined })
    expect(text(body).split('\n')).toEqual([
      '(earlier messages: call again with cursor=abc)',
      'Ada (2026-11-06 19:08 UTC, message id: 1793992100.000100): first [thread 1793992100.000100, 2 replies]',
      'Bo (2026-11-06 19:10 UTC, message id: 1793992200.000200): later',
    ])
  })

  it('tells the agent how to name a thread when the conversation is not one', async () => {
    manager.getConnector.mockReturnValue(connectorWith({}))
    const { body } = await call('slack_read_thread', { conversation: 'C1' })
    expect(body.result.isError).toBe(true)
    expect(text(body)).toContain('Pass thread with a message id')
  })

  it("returns Slack's refusal, with the reinstall step for a missing scope", async () => {
    manager.getConnector.mockReturnValue(connectorWith({ conversations: { info: vi.fn(async () => { throw platformError('missing_scope') }) } }))
    const { body } = await call('slack_read_conversation_info', { conversation: 'C1' })
    expect(body.result.isError).toBe(true)
    expect(text(body)).toBe('Slack refused: missing_scope. Reinstall the Slack app to enable this.')
  })

  it.each(['invalid_auth', 'token_revoked'])('answers 401 on %s, so the proxy runs reconnect', async (error) => {
    manager.getConnector.mockReturnValue(connectorWith({ chat: { getPermalink: vi.fn(async () => { throw platformError(error) }) } }))
    expect((await call('slack_get_permalink', { conversation: 'C1', message: '1.2' })).status).toBe(401)
  })

  it('targets the channel a bare conversation names, not the thread the connector last replied in', async () => {
    const postEphemeral = vi.fn(async () => ({ ok: true }))
    const connector = connectorWith({ chat: { postEphemeral } })
    ;(connector as any).threadContextMap.set('C1', { channel: 'C1', threadTs: '999.1' })
    manager.getConnector.mockReturnValue(connector)
    await call('slack_send_ephemeral', { conversation: 'C1', user: 'U1', text: 'hi' })
    expect(postEphemeral).toHaveBeenCalledWith({ channel: 'C1', user: 'U1', text: 'hi' })
  })

  it('refuses anything but POST', async () => {
    expect((await slackMcpConnection(record).serve!(new Request('https://slack.com/api', { method: 'GET' }))).status).toBe(405)
  })

  it('reacts to the named message, and treats a reaction already there as done', async () => {
    const add = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(platformError('already_reacted'))
    manager.getConnector.mockReturnValue(connectorWith({ reactions: { add } }))
    for (let i = 0; i < 2; i++) expect(text((await call('slack_add_reaction', { conversation: 'C1|100.1', message: '100.5', emoji: 'eyes' })).body)).toBe('Reacted.')
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '100.5', name: 'eyes' })
  })

  it('sends an ephemeral message into the thread the conversation is', async () => {
    const postEphemeral = vi.fn(async () => ({ ok: true }))
    manager.getConnector.mockReturnValue(connectorWith({ chat: { postEphemeral } }))
    await call('slack_send_ephemeral', { conversation: 'C1|100.1', user: 'U1', text: 'only you' })
    expect(postEphemeral).toHaveBeenCalledWith({ channel: 'C1', user: 'U1', text: 'only you', thread_ts: '100.1' })
  })

  it('schedules at the given time in the thread, and refuses a time without a zone', async () => {
    const scheduleMessage = vi.fn(async () => ({ ok: true, scheduled_message_id: 'Q1' }))
    manager.getConnector.mockReturnValue(connectorWith({ chat: { scheduleMessage } }))
    expect(text((await call('slack_schedule_message', { conversation: 'C1|100.1', at: '2026-11-07T09:00:00-08:00', text: 'standup' })).body)).toBe('Scheduled (id Q1).')
    expect(scheduleMessage).toHaveBeenCalledWith({ channel: 'C1', post_at: 1794070800, text: 'standup', thread_ts: '100.1' })
    expect((await call('slack_schedule_message', { conversation: 'C1', at: '2026-11-07T09:00:00', text: 'x' })).body.result.isError).toBe(true)
  })

  it("returns Slack's refusal when the agent edits someone else's message", async () => {
    manager.getConnector.mockReturnValue(connectorWith({ chat: { update: vi.fn(async () => { throw platformError('cant_update_message') }) } }))
    expect(text((await call('slack_edit_message', { conversation: 'C1', message: '1.2', text: 'x' })).body)).toBe('Slack refused: cant_update_message.')
  })

  it.each([
    ['slack_read_thread', { conversation: 'C1|100.1' }, { conversations: { replies: vi.fn(async () => ({ messages: [{ ts: '1793992100.000100', user: 'U1', text: 'root' }], response_metadata: { next_cursor: 'n2' } })) } },
      [['conversations', 'replies'], { channel: 'C1', ts: '100.1', limit: 50, cursor: undefined }], 'Ada (2026-11-06 19:08 UTC, message id: 1793992100.000100): root\n(later replies: call again with thread=100.1 cursor=n2)'],
    ['slack_read_conversation_info', { conversation: 'C1' }, { conversations: { info: vi.fn(async () => ({ channel: { name: 'eng', topic: { value: 'ship it' }, purpose: { value: '' }, is_private: false, num_members: 4, properties: { canvas: { file_id: 'F5' } } } })) } },
      [['conversations', 'info'], { channel: 'C1', include_num_members: true }], 'Name: eng\nTopic: ship it\nPrivate: no\nMembers: 4\nCanvas: F5'],
    ['slack_list_channel_members', { conversation: 'C1' }, { conversations: { members: vi.fn(async () => ({ members: ['U1', 'U2'] })) } },
      [['conversations', 'members'], { channel: 'C1', limit: 50, cursor: undefined }], 'Ada (U1)\nBo (U2)'],
    ['slack_read_user_profile', { user: 'U3' }, { users: { info: vi.fn(async () => ({ user: { name: 'cy', profile: { real_name: 'Cy', title: 'PM' }, tz: 'America/Los_Angeles', tz_label: 'Pacific Standard Time', is_bot: false } })) } },
      [['users', 'info'], { user: 'U3' }], 'Name: Cy\nTitle: PM\nTime zone: Pacific Standard Time (America/Los_Angeles)\nBot: no'],
    ['slack_get_permalink', { conversation: 'C1|100.1', message: '100.5' }, { chat: { getPermalink: vi.fn(async () => ({ permalink: 'https://x.slack.com/p1' })) } },
      [['chat', 'getPermalink'], { channel: 'C1', message_ts: '100.5' }], 'https://x.slack.com/p1'],
    ['slack_edit_message', { conversation: 'C1', message: '100.5', text: 'fixed' }, { chat: { update: vi.fn(async () => ({ ok: true })) } },
      [['chat', 'update'], { channel: 'C1', ts: '100.5', text: 'fixed' }], 'Edited.'],
    ['slack_delete_message', { conversation: 'C1', message: '100.5' }, { chat: { delete: vi.fn(async () => ({ ok: true })) } },
      [['chat', 'delete'], { channel: 'C1', ts: '100.5' }], 'Deleted.'],
    ['slack_get_reactions', { conversation: 'C1', message: '100.5' }, { reactions: { get: vi.fn(async () => ({ message: { reactions: [{ name: 'eyes', users: ['U1', 'U2'] }] } })) } },
      [['reactions', 'get'], { channel: 'C1', timestamp: '100.5', full: true }], ':eyes: Ada, Bo'],
    ['slack_list_emoji', {}, { emoji: { list: vi.fn(async () => ({ emoji: { shipit: 'https://x', partyparrot: 'alias:parrot' } })) } },
      [['emoji', 'list'], undefined], 'shipit, partyparrot'],
    ['slack_pin_message', { conversation: 'C1|100.1', message: '100.5' }, { pins: { add: vi.fn(async () => ({ ok: true })) } },
      [['pins', 'add'], { channel: 'C1', timestamp: '100.5' }], 'Pinned.'],
    ['slack_unpin_message', { conversation: 'C1', message: '100.5' }, { pins: { remove: vi.fn(async () => ({ ok: true })) } },
      [['pins', 'remove'], { channel: 'C1', timestamp: '100.5' }], 'Unpinned.'],
    ['slack_add_bookmark', { conversation: 'C1', title: 'Site', link: 'https://gamut.so' }, { bookmarks: { add: vi.fn(async () => ({ ok: true })) } },
      [['bookmarks', 'add'], { channel_id: 'C1', title: 'Site', type: 'link', link: 'https://gamut.so' }], 'Bookmarked.'],
    ['slack_create_canvas', { conversation: 'C1|100.1', title: 'Plan', markdown: '# Plan' }, { canvases: { create: vi.fn(async () => ({ canvas_id: 'F9' })) } },
      [['canvases', 'create'], { title: 'Plan', document_content: { type: 'markdown', markdown: '# Plan' }, channel_id: 'C1' }], 'Created canvas F9.'],
    ['slack_read_canvas', { canvas: 'F9' }, { apiCall: vi.fn(async () => ({ content: '# Plan\n- ship' })) },
      [['apiCall'], undefined], '# Plan\n- ship'],
    ['slack_edit_canvas', { canvas: 'F9', markdown: 'more' }, { canvases: { edit: vi.fn(async () => ({ ok: true })) } },
      [['canvases', 'edit'], { canvas_id: 'F9', changes: [{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown: 'more' } }] }], 'Canvas updated.'],
    ['slack_read_list', { list: 'F7' }, { apiCall: vi.fn(async () => ({ list: { list_metadata: { schema: [{ id: 'Col1', name: 'Task', type: 'text' }] } }, items: [{ id: 'Rec1', fields: [{ column_id: 'Col1', text: 'ship' }] }] })) },
      [['apiCall'], undefined], 'Columns: Task (Col1, text)\nRec1: Col1=ship'],
    ['slack_read_list', { list: 'F8' }, { apiCall: vi.fn(async () => ({ list: { list_metadata: { schema: [{ id: 'Col1', name: 'Task', type: 'text' }, { id: 'Col2' }] } }, items: [] })) },
      [['apiCall'], undefined], 'Columns: Task (Col1, text), Col2 (Col2)'],
    ['slack_add_list_item', { list: 'F7', column: 'Col1', text: 'ship' }, { slackLists: { items: { create: vi.fn(async () => ({ item: { id: 'Rec2' } })) } } },
      [['slackLists', 'items', 'create'], { list_id: 'F7', initial_fields: [{ column_id: 'Col1', rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'ship' }] }] }] }] }], 'Added item Rec2.'],
    ['slack_remove_reaction', { conversation: 'C1', message: '100.5', emoji: 'eyes' }, { reactions: { remove: vi.fn(async () => ({ ok: true })) } },
      [['reactions', 'remove'], { channel: 'C1', timestamp: '100.5', name: 'eyes' }], 'Removed.'],
    ['slack_list_pins', { conversation: 'C1' }, { pins: { list: vi.fn(async () => ({ items: [{ message: { ts: '1793992100.000100', user: 'U1', text: 'decision' } }] })) } },
      [['pins', 'list'], { channel: 'C1' }], 'Ada (2026-11-06 19:08 UTC, message id: 1793992100.000100): decision'],
    ['slack_list_bookmarks', { conversation: 'C1' }, { bookmarks: { list: vi.fn(async () => ({ bookmarks: [{ id: 'Bk1', title: 'Site', link: 'https://gamut.so' }] })) } },
      [['bookmarks', 'list'], { channel_id: 'C1' }], 'Bk1: Site https://gamut.so'],
    ['slack_remove_bookmark', { conversation: 'C1', bookmark: 'Bk1' }, { bookmarks: { remove: vi.fn(async () => ({ ok: true })) } },
      [['bookmarks', 'remove'], { channel_id: 'C1', bookmark_id: 'Bk1' }], 'Removed.'],
    ['slack_list_scheduled_messages', { conversation: 'C1' }, { chat: { scheduledMessages: { list: vi.fn(async () => ({ scheduled_messages: [{ id: 'Q1', post_at: 1794070800, text: 'standup' }] })) } } },
      [['chat', 'scheduledMessages', 'list'], { channel: 'C1', limit: 50, cursor: undefined }], 'Q1: 2026-11-07 17:00 UTC standup'],
    ['slack_delete_scheduled_message', { conversation: 'C1', scheduled: 'Q1' }, { chat: { deleteScheduledMessage: vi.fn(async () => ({ ok: true })) } },
      [['chat', 'deleteScheduledMessage'], { channel: 'C1', scheduled_message_id: 'Q1' }], 'Cancelled.'],
    ['slack_invite_to_channel', { conversation: 'C3', users: ['U1', 'U2'] }, { conversations: { invite: vi.fn(async () => ({ ok: true })) } },
      [['conversations', 'invite'], { channel: 'C3', users: 'U1,U2' }], 'Invited.'],
    ['slack_set_purpose', { conversation: 'C1', purpose: 'Launch' }, { conversations: { setPurpose: vi.fn(async () => ({ ok: true })) } },
      [['conversations', 'setPurpose'], { channel: 'C1', purpose: 'Launch' }], 'Description set.'],
    ['slack_list_user_groups', {}, { usergroups: { list: vi.fn(async () => ({ usergroups: [{ id: 'S1', handle: 'eng', name: 'Engineering', user_count: 4 }] })) } },
      [['usergroups', 'list'], { include_count: true }], '@eng (S1): Engineering, 4 people'],
    ['slack_get_presence', { user: 'U1' }, { users: { getPresence: vi.fn(async () => ({ presence: 'away' })) } },
      [['users', 'getPresence'], { user: 'U1' }], 'Away.'],
    ['slack_delete_canvas', { canvas: 'F9' }, { canvases: { delete: vi.fn(async () => ({ ok: true })) } },
      [['canvases', 'delete'], { canvas_id: 'F9' }], 'Deleted.'],
    ['slack_join_channel', { conversation: 'C2' }, { conversations: { join: vi.fn(async () => ({ ok: true })) } },
      [['conversations', 'join'], { channel: 'C2' }], 'Joined.'],
    ['slack_create_channel', { name: 'project-atlas' }, { conversations: { create: vi.fn(async () => ({ channel: { id: 'C3', name: 'project-atlas' } })) } },
      [['conversations', 'create'], { name: 'project-atlas', is_private: false }], 'Created #project-atlas (C3).'],
    ['slack_set_topic', { conversation: 'C1', topic: 'Ship Thursday' }, { conversations: { setTopic: vi.fn(async () => ({ ok: true })) } },
      [['conversations', 'setTopic'], { channel: 'C1', topic: 'Ship Thursday' }], 'Topic set.'],
  ] as const)('%s calls Slack and answers in text', async (name, args, client, [path, expected], answer) => {
    const connector = connectorWith(client as Record<string, unknown>)
    manager.getConnector.mockReturnValue(connector)
    expect(text((await call(name, args)).body)).toBe(answer)
    const method = path.reduce((at: any, key) => at[key], (connector as any).app.client)
    if (name === 'slack_read_canvas') expect(method).toHaveBeenCalledWith('canvases.getContent', { canvas_id: 'F9', content_type: 'markdown' })
    else if (name === 'slack_read_list') expect(method).toHaveBeenCalledWith('slackLists.items.list', { list_id: args.list, limit: 50, cursor: undefined, include_list: true })
    else expect(method).toHaveBeenCalledWith(...(expected === undefined ? [] : [expected]))
  })

  it('saves a shared file with a confined write, and refuses a canvas or a file over the limit before downloading', async () => {
    const download = vi.mocked(downloadSlackUrl).mockResolvedValue(Buffer.from('pdf'))
    const info = vi.fn()
      .mockResolvedValueOnce({ file: { name: 'deck.pdf', size: 3, url_private_download: 'https://files.slack.com/d' } })
      .mockResolvedValueOnce({ file: { name: 'Plan', filetype: 'canvas', url_private_download: 'https://files.slack.com/c' } })
      .mockResolvedValueOnce({ file: { name: 'huge.mov', size: 51 * 1024 * 1024, url_private_download: 'https://files.slack.com/h' } })
    const connector = connectorWith({ files: { info } })
    ;(connector as any).app.client.token = 'xoxb-fake'
    manager.getConnector.mockReturnValue(connector)
    expect(text((await call('slack_read_file', { file: 'F1' })).body)).toMatch(/^Saved deck\.pdf to \/workspace\/uploads\/deck-\d+\.pdf\.$/)
    expect(download).toHaveBeenCalledWith('https://files.slack.com/d', 'xoxb-fake')
    expect(actor.write).toHaveBeenCalledWith(expect.stringMatching(/^uploads\/deck-\d+\.pdf$/), Buffer.from('pdf'), { confined: true, overwrite: false })
    expect(text((await call('slack_read_file', { file: 'F2' })).body)).toBe('This is a canvas: read it with slack_read_canvas.')
    expect(text((await call('slack_read_file', { file: 'F3' })).body)).toBe('The file is larger than 50 MB.')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('uploads a workspace file into the thread, and says when the file is missing', async () => {
    const filesUploadV2 = vi.fn(async () => ({ ok: true }))
    manager.getConnector.mockReturnValue(connectorWith({ filesUploadV2 }))
    const oversized = new Blob(['x']).stream()
    const cancel = vi.spyOn(oversized, 'cancel')
    actor.readSized
      .mockResolvedValueOnce({ size: 51 * 1024 * 1024, stream: oversized })
      .mockResolvedValueOnce({ size: 6, stream: new Blob(['report']).stream() })
      .mockRejectedValueOnce(new WorkspaceFileError('not-found', 'No file at /workspace/gone.pdf.'))
    expect(text((await call('slack_upload_file', { conversation: 'C1', path: '/workspace/huge.mov' })).body)).toBe('The file is larger than 50 MB.')
    expect(cancel).toHaveBeenCalled()
    expect(filesUploadV2).not.toHaveBeenCalled()
    expect(text((await call('slack_upload_file', { conversation: 'C1|100.1', path: '/workspace/report.pdf' })).body)).toBe('Uploaded.')
    expect(filesUploadV2).toHaveBeenCalledWith({ channel_id: 'C1', file: Buffer.from('report'), filename: 'report.pdf', thread_ts: '100.1' })
    expect(actor.readSized).toHaveBeenCalledWith('/workspace/report.pdf', { confined: true })
    expect(text((await call('slack_upload_file', { conversation: 'C1', path: '/workspace/gone.pdf' })).body)).toBe('No file at /workspace/gone.pdf.')
  })

  it("keeps the container's Slack setup guide on the manifest's permission list", () => {
    const guide = readFileSync(new URL('../../../../agent-container/src/tools/chat/list-available-chat-providers.ts', import.meta.url), 'utf8')
    expect(BOT_SCOPES.filter(scope => (guide.match(new RegExp(`(^|[\\s",])${scope}([\\s",]|$)`, 'gm')) ?? []).length < 2)).toEqual([])
  })

  it('refuses to upload through a link that leaves the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slack-mcp-ws-'))
    const outside = join(mkdtempSync(join(tmpdir(), 'slack-mcp-out-')), 'secret.txt')
    writeFileSyncNode(outside, 'host secret')
    symlinkSync(outside, join(root, 'link.txt'))
    const files = new LocalFileOps(() => root)
    actor.readSized.mockImplementationOnce((path: string, options: { confined?: boolean }) => files.readSized(path, options))
    const filesUploadV2 = vi.fn(async () => ({ ok: true }))
    manager.getConnector.mockReturnValue(connectorWith({ filesUploadV2 }))
    const { body } = await call('slack_upload_file', { conversation: 'C1', path: '/workspace/link.txt' })
    expect(body.result.isError).toBe(true)
    expect(filesUploadV2).not.toHaveBeenCalled()
  })

  it('tells the agent when Slack is rate limiting the bot', async () => {
    manager.getConnector.mockReturnValue(connectorWith({ chat: { getPermalink: vi.fn(async () => { throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' }) }) } }))
    expect(text((await call('slack_get_permalink', { conversation: 'C1', message: '1.2' })).body)).toBe('Slack is rate limiting this bot. Try again shortly.')
  })

  it.each([['no live connector', () => undefined], ['a connector between connections', () => connectorWith({})]])('says Slack is not connected with %s', async (_name, live) => {
    const connector = live()
    if (connector) (connector as any).app = null
    manager.getConnector.mockReturnValue(connector)
    const { body } = await call('slack_read_user_profile', { user: 'U1' })
    expect(text(body)).toBe('Slack is not connected right now. Try again shortly.')
  })
})
