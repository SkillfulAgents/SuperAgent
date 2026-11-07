import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import type { IntegrationMcpConnection } from '../agent-integrations/mcp-types'
import { getIntegration } from '../agent-integrations/store'
import { agentIntegrationManager } from '../agent-integrations/agent-integration-manager'
import { SlackConnector, slackMessageLine, type SlackApi } from './slack-connector'
import { isUnrecoverableSlackError, slackPlatformErrorCode } from './slack-error'
import { captureException } from '@shared/lib/error-reporting'
import { agentRegistry, workspaceBasename, WorkspaceFileError } from '../agent-actor'
import { downloadSlackUrl, MAX_FILE_DOWNLOAD_SIZE } from './chat-input'
import { sanitizeUploadFilename, withUploadTimestamp } from '../utils/path-safety'

const PAGE = 50

const conversation = z.string().describe('Chat id of the conversation: the one in your session prompt, or the thread a message shows (for example C0123, or C0123|1793992161.065119 for a thread)')
const cursor = z.string().optional().describe('Cursor from a previous page')

const canvasContent = z.object({ content: z.string().optional() })
// The pinned SDK's Channel type has no properties: the channel canvas id is parsed from the response.
const channelCanvas = z.object({ properties: z.object({ canvas: z.object({ file_id: z.string() }).optional() }).optional() })
const canvasLine = (info: unknown) => {
  const id = channelCanvas.safeParse(info).data?.properties?.canvas?.file_id
  return id && `Canvas: ${id}`
}
const listPage = z.object({
  items: z.array(z.object({ id: z.string(), fields: z.array(z.object({ column_id: z.string().optional(), text: z.string().optional(), value: z.unknown().optional() })).optional() })).optional(),
  list: z.object({ list_metadata: z.object({ schema: z.array(z.object({ id: z.string(), name: z.string().optional(), type: z.string().optional() })).optional() }).optional() }).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
})

type Message = { ts?: string; user?: string; text?: string; reply_count?: number; files?: Array<{ id?: string; name?: string; title?: string }> }

async function readMessages(api: SlackApi, messages: Message[], threads: boolean): Promise<string[]> {
  const lines: string[] = []
  for (const m of messages) {
    const replies = threads && m.reply_count ? ` [thread ${m.ts}, ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}]` : ''
    const text = m.text ? await api.plainText(m.text) : ''
    const name = m.user ? (await api.userName(m.user)) || m.user : 'Unknown'
    // A thread root keeps its line even without text, so its thread stays reachable.
    const line = slackMessageLine(name, m.ts, text, (m.files ?? []).map(f => `${f.name || f.title || 'file'}${f.id ? `, id ${f.id}` : ''}`), replies ? '(no text)' : undefined)
    if (line) lines.push(line + replies)
  }
  return lines
}

/** What a tool may need beyond Slack: whose workspace a file lands in or comes from. */
interface SlackToolContext { agentSlug: string }

interface SlackTool {
  name: string
  description: string
  args: z.ZodRawShape
  run(api: SlackApi, args: unknown, context: SlackToolContext): Promise<string>
}
/** Types `run` against its own arguments, which it parses again: the table then holds one entry type. */
function tool<Shape extends z.ZodRawShape>(t: { name: string; description: string; args: Shape; run(api: SlackApi, args: z.infer<z.ZodObject<Shape>>, context: SlackToolContext): Promise<string> }): SlackTool {
  const schema = z.object(t.args)
  return { ...t, run: (api, args, context) => t.run(api, schema.parse(args), context) }
}

/** Every Slack ability the agent has as its bot. Adding one is adding an entry. */
export const SLACK_TOOLS = [
  tool({
    name: 'slack_read_channel',
    description: 'Read a Slack channel the bot is in, newest page first. Each line has the sender, time and message id. Threads show as [thread <id>, N replies]: read them with slack_read_thread.',
    args: { conversation, cursor },
    async run(api, { conversation, cursor }) {
      const page = await api.client.conversations.history({ channel: api.channelOf(conversation).channel, limit: PAGE, cursor })
      const lines = await readMessages(api, [...page.messages ?? []].reverse(), true)
      const next = page.response_metadata?.next_cursor
      if (next) lines.unshift(`(earlier messages: call again with cursor=${next})`)
      return lines.join('\n') || 'No messages.'
    },
  }),
  tool({
    name: 'slack_read_thread',
    description: 'Read a Slack thread from its first message. Pass thread (a message id) to read a thread other than the conversation you are in.',
    args: { conversation, thread: z.string().optional().describe('Message id of the thread\'s first message'), cursor },
    async run(api, { conversation, thread, cursor }) {
      const { channel, threadTs } = api.channelOf(conversation)
      const ts = thread ?? threadTs
      if (!ts) throw new SlackToolRefusal('This conversation is not a thread. Pass thread with a message id from slack_read_channel.')
      const page = await api.client.conversations.replies({ channel, ts, limit: PAGE, cursor })
      const lines = await readMessages(api, page.messages ?? [], false)
      const next = page.response_metadata?.next_cursor
      if (next) lines.push(`(later replies: call again with thread=${ts} cursor=${next})`)
      return lines.join('\n') || 'No messages.'
    },
  }),
  tool({
    name: 'slack_read_conversation_info',
    description: 'A Slack conversation\'s name, topic, purpose, privacy and member count.',
    args: { conversation },
    async run(api, { conversation }) {
      const { channel: info } = await api.client.conversations.info({ channel: api.channelOf(conversation).channel, include_num_members: true })
      if (!info) return 'No such conversation.'
      return [
        `Name: ${info.name ?? (info.is_im ? 'direct message' : info.id)}`,
        info.topic?.value && `Topic: ${info.topic.value}`,
        info.purpose?.value && `Purpose: ${info.purpose.value}`,
        `Private: ${info.is_private || info.is_im ? 'yes' : 'no'}`,
        info.num_members !== undefined && `Members: ${info.num_members}`,
        canvasLine(info),
      ].filter(Boolean).join('\n')
    },
  }),
  tool({
    name: 'slack_list_channel_members',
    description: 'People in a Slack conversation, with their user ids.',
    args: { conversation, cursor },
    async run(api, { conversation, cursor }) {
      const page = await api.client.conversations.members({ channel: api.channelOf(conversation).channel, limit: PAGE, cursor })
      const lines = await Promise.all((page.members ?? []).map(async id => `${(await api.userName(id)) || id} (${id})`))
      const next = page.response_metadata?.next_cursor
      if (next) lines.push(`(more members: call again with cursor=${next})`)
      return lines.join('\n') || 'No members.'
    },
  }),
  tool({
    name: 'slack_read_user_profile',
    description: 'A Slack user\'s name, title, time zone and whether they are a bot.',
    args: { user: z.string().describe('Slack user id, for example U0123') },
    async run(api, { user }) {
      const { user: u } = await api.client.users.info({ user })
      if (!u) return 'No such user.'
      return [
        `Name: ${u.profile?.real_name || u.real_name || u.name}`,
        u.profile?.display_name && `Display name: ${u.profile.display_name}`,
        u.profile?.title && `Title: ${u.profile.title}`,
        u.tz && `Time zone: ${u.tz_label ?? u.tz} (${u.tz})`,
        `Bot: ${u.is_bot ? 'yes' : 'no'}`,
      ].filter(Boolean).join('\n')
    },
  }),
  tool({
    name: 'slack_get_permalink',
    description: 'A link to one Slack message, to cite it elsewhere.',
    args: { conversation, message: z.string().describe('Message id') },
    async run(api, { conversation, message }) {
      const { permalink } = await api.client.chat.getPermalink({ channel: api.channelOf(conversation).channel, message_ts: message })
      return permalink ?? 'Slack returned no link.'
    },
  }),
  tool({
    name: 'slack_add_reaction',
    description: 'React to a Slack message with an emoji. Use it to acknowledge a message that needs no reply, or to mark one seen or done.',
    args: { conversation, message: z.string().describe('Message id'), emoji: z.string().describe('Emoji name without colons, for example eyes or white_check_mark') },
    async run(api, { conversation, message, emoji }) {
      try {
        await api.client.reactions.add({ channel: api.channelOf(conversation).channel, timestamp: message, name: emoji })
      } catch (err) {
        if (slackPlatformErrorCode(err) !== 'already_reacted') throw err
      }
      return 'Reacted.'
    },
  }),
  tool({
    name: 'slack_send_ephemeral',
    description: 'Send a message only one person in the conversation sees. For a thread conversation it shows in that thread.',
    args: { conversation, user: z.string().describe('Slack user id of the person who sees it'), text: z.string() },
    async run(api, { conversation, user, text }) {
      const { channel, threadTs } = api.channelOf(conversation)
      await api.client.chat.postEphemeral({ channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      return 'Sent.'
    },
  }),
  tool({
    name: 'slack_schedule_message',
    description: 'Schedule a Slack message for later, for example a reminder. A reminder that is only a message needs no scheduled task. For a thread conversation it posts in that thread.',
    args: { conversation, at: z.iso.datetime({ offset: true }).describe('When to post, ISO 8601 with a time zone, for example 2026-11-07T09:00:00-08:00'), text: z.string() },
    async run(api, { conversation, at, text }) {
      const { channel, threadTs } = api.channelOf(conversation)
      const { scheduled_message_id } = await api.client.chat.scheduleMessage({ channel, post_at: Math.floor(Date.parse(at) / 1000), text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      return `Scheduled (id ${scheduled_message_id}).`
    },
  }),
  tool({
    name: 'slack_edit_message',
    description: 'Replace the text of a message you posted. Slack refuses other people\'s messages.',
    args: { conversation, message: z.string().describe('Message id'), text: z.string() },
    async run(api, { conversation, message, text }) {
      await api.client.chat.update({ channel: api.channelOf(conversation).channel, ts: message, text })
      return 'Edited.'
    },
  }),
  tool({
    name: 'slack_delete_message',
    description: 'Delete a message you posted. Slack refuses other people\'s messages.',
    args: { conversation, message: z.string().describe('Message id') },
    async run(api, { conversation, message }) {
      await api.client.chat.delete({ channel: api.channelOf(conversation).channel, ts: message })
      return 'Deleted.'
    },
  }),
  tool({
    name: 'slack_get_reactions',
    description: 'Who reacted to a Slack message, and with which emoji.',
    args: { conversation, message: z.string().describe('Message id') },
    async run(api, { conversation, message }) {
      const { message: m } = await api.client.reactions.get({ channel: api.channelOf(conversation).channel, timestamp: message, full: true })
      const lines = await Promise.all((m?.reactions ?? []).map(async r => `:${r.name}: ${(await Promise.all((r.users ?? []).map(async id => (await api.userName(id)) || id))).join(', ')}`))
      return lines.join('\n') || 'No reactions.'
    },
  }),
  tool({
    name: 'slack_list_emoji',
    description: "The workspace's custom emoji names, to react with them.",
    args: {},
    async run(api) {
      const names = Object.keys((await api.client.emoji.list()).emoji ?? {})
      return names.length ? names.slice(0, 500).join(', ') + (names.length > 500 ? ` (and ${names.length - 500} more)` : '') : 'No custom emoji.'
    },
  }),
  tool({
    name: 'slack_pin_message',
    description: 'Pin a message in its conversation, for example a decision people should find later.',
    args: { conversation, message: z.string().describe('Message id') },
    async run(api, { conversation, message }) {
      await api.client.pins.add({ channel: api.channelOf(conversation).channel, timestamp: message })
      return 'Pinned.'
    },
  }),
  tool({
    name: 'slack_unpin_message',
    description: 'Unpin a pinned message.',
    args: { conversation, message: z.string().describe('Message id') },
    async run(api, { conversation, message }) {
      await api.client.pins.remove({ channel: api.channelOf(conversation).channel, timestamp: message })
      return 'Unpinned.'
    },
  }),
  tool({
    name: 'slack_add_bookmark',
    description: 'Add a link to the bookmarks bar at the top of a channel.',
    args: { conversation, title: z.string(), link: z.url() },
    async run(api, { conversation, title, link }) {
      await api.client.bookmarks.add({ channel_id: api.channelOf(conversation).channel, title, type: 'link', link })
      return 'Bookmarked.'
    },
  }),
  tool({
    name: 'slack_create_canvas',
    description: 'Write a canvas from markdown, for example a plan or a running summary, and add it as a tab in a channel (not a DM). Free Slack plans allow one canvas tab per channel: slack_read_conversation_info shows an existing one to read or edit.',
    args: { conversation, title: z.string(), markdown: z.string() },
    async run(api, { conversation, title, markdown }) {
      const { canvas_id } = await api.client.canvases.create({ title, document_content: { type: 'markdown', markdown }, channel_id: api.channelOf(conversation).channel })
      return `Created canvas ${canvas_id}.`
    },
  }),
  tool({
    name: 'slack_read_canvas',
    description: 'Read a canvas as markdown.',
    args: { canvas: z.string().describe('Canvas id') },
    async run(api, { canvas }) {
      // Newer than the pinned SDK's typed methods: called by name, its answer parsed.
      const { content } = canvasContent.parse(await api.client.apiCall('canvases.getContent', { canvas_id: canvas, content_type: 'markdown' }))
      return content || 'The canvas is empty.'
    },
  }),
  tool({
    name: 'slack_edit_canvas',
    description: 'Add markdown to the end of a canvas, or replace its whole content.',
    args: { canvas: z.string().describe('Canvas id'), markdown: z.string(), replace: z.boolean().optional().describe('Replace the whole canvas instead of adding to its end') },
    async run(api, { canvas, markdown, replace }) {
      await api.client.canvases.edit({ canvas_id: canvas, changes: [{ operation: replace ? 'replace' : 'insert_at_end', document_content: { type: 'markdown', markdown } }] })
      return 'Canvas updated.'
    },
  }),
  tool({
    name: 'slack_read_list',
    description: 'Read a Slack list: its columns (name, id, type) and its items. Use a column id to add items. Lists need a paid Slack plan.',
    args: { list: z.string().describe('List id'), cursor },
    async run(api, { list, cursor }) {
      // include_list is newer than the pinned SDK's types: called by name, its answer parsed.
      const page = listPage.parse(await api.client.apiCall('slackLists.items.list', { list_id: list, limit: PAGE, cursor, include_list: true }))
      const columns = (page.list?.list_metadata?.schema ?? []).map(c => `${c.name ?? c.id} (${[c.id, c.type].filter(Boolean).join(', ')})`)
      const lines = (page.items ?? []).map(item => `${item.id}: ${(item.fields ?? []).map(f => `${f.column_id}=${f.text ?? (f.value === undefined || f.value === null ? '' : String(f.value))}`).join('; ')}`)
      const next = page.response_metadata?.next_cursor
      if (next) lines.push(`(more items: call again with cursor=${next})`)
      return [columns.length ? `Columns: ${columns.join(', ')}` : '', ...lines].filter(Boolean).join('\n') || 'No items.'
    },
  }),
  tool({
    name: 'slack_add_list_item',
    description: 'Add an item to a Slack list, with text in one column (a column id from slack_read_list).',
    args: { list: z.string().describe('List id'), column: z.string().describe('Column id'), text: z.string() },
    async run(api, { list, column, text }) {
      const { item } = await api.client.slackLists.items.create({ list_id: list, initial_fields: [{ column_id: column, rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }] }] })
      return item?.id ? `Added item ${item.id}.` : 'Added.'
    },
  }),
  tool({
    name: 'slack_join_channel',
    description: 'Join a public Slack channel so you can read and post there.',
    args: { conversation },
    async run(api, { conversation }) {
      await api.client.conversations.join({ channel: api.channelOf(conversation).channel })
      return 'Joined.'
    },
  }),
  tool({
    name: 'slack_create_channel',
    description: 'Create a Slack channel. The bot is its first member.',
    args: { name: z.string().describe('Lowercase, no spaces, for example project-atlas'), private: z.boolean().optional() },
    async run(api, { name, private: isPrivate }) {
      const { channel } = await api.client.conversations.create({ name, is_private: isPrivate ?? false })
      return `Created #${channel?.name} (${channel?.id}).`
    },
  }),
  tool({
    name: 'slack_set_topic',
    description: "Set a channel's topic.",
    args: { conversation, topic: z.string() },
    async run(api, { conversation, topic }) {
      await api.client.conversations.setTopic({ channel: api.channelOf(conversation).channel, topic })
      return 'Topic set.'
    },
  }),
  tool({
    name: 'slack_remove_reaction',
    description: 'Take back an emoji reaction you added.',
    args: { conversation, message: z.string().describe('Message id'), emoji: z.string().describe('Emoji name without colons') },
    async run(api, { conversation, message, emoji }) {
      await api.client.reactions.remove({ channel: api.channelOf(conversation).channel, timestamp: message, name: emoji })
      return 'Removed.'
    },
  }),
  tool({
    name: 'slack_list_pins',
    description: 'The pinned messages in a conversation.',
    args: { conversation },
    async run(api, { conversation }) {
      const { items } = await api.client.pins.list({ channel: api.channelOf(conversation).channel })
      const lines = await readMessages(api, (items ?? []).flatMap(item => ('message' in item && item.message ? [item.message] : [])), false)
      return lines.join('\n') || 'Nothing pinned.'
    },
  }),
  tool({
    name: 'slack_list_bookmarks',
    description: "A channel's bookmarks, with their ids.",
    args: { conversation },
    async run(api, { conversation }) {
      const { bookmarks } = await api.client.bookmarks.list({ channel_id: api.channelOf(conversation).channel })
      return (bookmarks ?? []).map(b => `${b.id}: ${b.title} ${b.link ?? ''}`.trim()).join('\n') || 'No bookmarks.'
    },
  }),
  tool({
    name: 'slack_remove_bookmark',
    description: 'Remove a bookmark you added to a channel.',
    args: { conversation, bookmark: z.string().describe('Bookmark id from slack_list_bookmarks') },
    async run(api, { conversation, bookmark }) {
      await api.client.bookmarks.remove({ channel_id: api.channelOf(conversation).channel, bookmark_id: bookmark })
      return 'Removed.'
    },
  }),
  tool({
    name: 'slack_list_scheduled_messages',
    description: 'Messages you scheduled in a conversation and not yet sent, with their ids.',
    args: { conversation, cursor },
    async run(api, { conversation, cursor }) {
      const page = await api.client.chat.scheduledMessages.list({ channel: api.channelOf(conversation).channel, limit: PAGE, cursor })
      const lines = (page.scheduled_messages ?? []).map(m => `${m.id}: ${m.post_at ? new Date(m.post_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''} ${m.text ?? ''}`)
      const next = page.response_metadata?.next_cursor
      if (next) lines.push(`(more: call again with cursor=${next})`)
      return lines.join('\n') || 'Nothing scheduled.'
    },
  }),
  tool({
    name: 'slack_delete_scheduled_message',
    description: 'Cancel a message you scheduled.',
    args: { conversation, scheduled: z.string().describe('Scheduled message id') },
    async run(api, { conversation, scheduled }) {
      await api.client.chat.deleteScheduledMessage({ channel: api.channelOf(conversation).channel, scheduled_message_id: scheduled })
      return 'Cancelled.'
    },
  }),
  tool({
    name: 'slack_invite_to_channel',
    description: 'Add people to a channel, for example one you created.',
    args: { conversation, users: z.array(z.string()).min(1).describe('Slack user ids') },
    async run(api, { conversation, users }) {
      await api.client.conversations.invite({ channel: api.channelOf(conversation).channel, users: users.join(',') })
      return 'Invited.'
    },
  }),
  tool({
    name: 'slack_set_purpose',
    description: "Set a channel's description.",
    args: { conversation, purpose: z.string() },
    async run(api, { conversation, purpose }) {
      await api.client.conversations.setPurpose({ channel: api.channelOf(conversation).channel, purpose })
      return 'Description set.'
    },
  }),
  tool({
    name: 'slack_list_user_groups',
    description: 'Slack user groups such as @eng, to pull a team in. Mention one in a reply as <!subteam^ID>.',
    args: {},
    async run(api) {
      const { usergroups } = await api.client.usergroups.list({ include_count: true })
      return (usergroups ?? []).map(g => `@${g.handle} (${g.id}): ${g.name}${g.user_count !== undefined ? `, ${g.user_count} people` : ''}`).join('\n') || 'No user groups.'
    },
  }),
  tool({
    name: 'slack_get_presence',
    description: 'Whether a person is active in Slack right now.',
    args: { user: z.string().describe('Slack user id') },
    async run(api, { user }) {
      const { presence } = await api.client.users.getPresence({ user })
      return presence === 'active' ? 'Active.' : 'Away.'
    },
  }),
  tool({
    name: 'slack_read_file',
    description: 'Save a file shared in Slack into your workspace to open it. Files show in messages as [file: name]; their id comes from the message. Canvases cannot be read this way.',
    args: { file: z.string().describe('File id, for example F0123') },
    async run(api, { file }, { agentSlug }) {
      const { file: info } = await api.client.files.info({ file })
      if (info?.filetype === 'canvas' || info?.filetype === 'quip') throw new SlackToolRefusal('This is a canvas: read it with slack_read_canvas.')
      if (!info?.name || !info.url_private_download || !api.client.token) throw new SlackToolRefusal('Slack has no download for this file.')
      if ((info.size ?? 0) > MAX_FILE_DOWNLOAD_SIZE) throw new SlackToolRefusal(`The file is larger than ${MAX_FILE_DOWNLOAD_SIZE / 1024 / 1024} MB.`)
      const data = await downloadSlackUrl(info.url_private_download, api.client.token)
      if (!data) throw new SlackToolRefusal('Slack would not send this file.')
      const name = `uploads/${withUploadTimestamp(sanitizeUploadFilename(info.name))}`
      await agentRegistry.get(agentSlug).files.write(name, data, { confined: true, overwrite: false })
      return `Saved ${info.name} to /workspace/${name}.`
    },
  }),
  tool({
    name: 'slack_upload_file',
    description: 'Post a file from your workspace into a Slack conversation, for example a report for another channel. In the conversation you are answering, deliver files the usual way.',
    args: { conversation, path: z.string().describe('Workspace path, for example /workspace/report.pdf'), comment: z.string().optional() },
    async run(api, { conversation, path, comment }, { agentSlug }) {
      const { size, stream } = await agentRegistry.get(agentSlug).files.readSized(path, { confined: true })
      if (size > MAX_FILE_DOWNLOAD_SIZE) {
        await stream.cancel()
        throw new SlackToolRefusal(`The file is larger than ${MAX_FILE_DOWNLOAD_SIZE / 1024 / 1024} MB.`)
      }
      const { channel, threadTs } = api.channelOf(conversation)
      const upload = { channel_id: channel, file: Buffer.from(await new Response(stream).arrayBuffer()), filename: workspaceBasename(path), ...(comment ? { initial_comment: comment } : {}) }
      await (threadTs ? api.client.filesUploadV2({ ...upload, thread_ts: threadTs }) : api.client.filesUploadV2(upload))
      return 'Uploaded.'
    },
  }),
  tool({
    name: 'slack_delete_canvas',
    description: 'Delete a canvas you created.',
    args: { canvas: z.string().describe('Canvas id') },
    async run(api, { canvas }) {
      await api.client.canvases.delete({ canvas_id: canvas })
      return 'Deleted.'
    },
  }),
]

/** Token failures the socket's reconnect classifier does not cover; the proxy's reconnect handles them. */
const REVOKED = new Set(['token_revoked', 'token_expired'])

/** A refusal the agent can act on, returned as the tool's answer. */
class SlackToolRefusal extends Error {}

function refusalText(err: unknown): string | null {
  if (err instanceof SlackToolRefusal) return err.message
  if (err instanceof WorkspaceFileError) return err.message
  // The client already waited and retried; this is the rate limit outlasting those retries.
  if (err && typeof err === 'object' && 'code' in err && err.code === 'slack_webapi_rate_limited_error') return 'Slack is rate limiting this bot. Try again shortly.'
  const code = slackPlatformErrorCode(err)
  if (!code) return null
  if (code === 'missing_scope') return 'Slack refused: missing_scope. Reinstall the Slack app to enable this.'
  return `Slack refused: ${code}.`
}

/** Answers one MCP request against the live connector. Credential failures become a 401 for the proxy's recovery. */
async function serveSlackMcp(integrationId: string, agentSlug: string, request: Request): Promise<Response> {
  // Stateless JSON responses: there is no stream to open with GET or to end with DELETE.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  let unauthorized = false
  const server = new McpServer({ name: 'slack', version: '1.0.0' })
  const register = (t: SlackTool) => {
    server.registerTool(t.name, { description: t.description, inputSchema: t.args }, async args => {
      const connector = agentIntegrationManager.getConnector(integrationId)
      const api = connector instanceof SlackConnector ? connector.api() : null
      if (!api) return { isError: true, content: [{ type: 'text' as const, text: 'Slack is not connected right now. Try again shortly.' }] }
      try {
        return { content: [{ type: 'text' as const, text: await t.run(api, args, { agentSlug }) }] }
      } catch (err) {
        if (isUnrecoverableSlackError(err) || REVOKED.has(slackPlatformErrorCode(err) ?? '')) unauthorized = true
        const text = refusalText(err)
        if (!text) captureException(err, { tags: { component: 'slack-mcp', operation: t.name } })
        return { isError: true, content: [{ type: 'text' as const, text: text ?? 'The Slack call failed.' }] }
      }
    })
  }
  SLACK_TOOLS.forEach(register)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    return unauthorized ? new Response(null, { status: 401 }) : response
  } finally {
    await server.close()
  }
}

function workspaceOf(integrationId: string): string {
  const connector = agentIntegrationManager.getConnector(integrationId)
  return (connector instanceof SlackConnector && connector.workspaceName) || 'Slack'
}

export function slackMcpConnection(record: AgentIntegrationRecord): IntegrationMcpConnection {
  return {
    integrationId: record.id, agentSlug: record.agentSlug,
    url: 'https://slack.com/api',
    identity: { provider: 'Slack', name: record.name || 'Slack bot', workspace: workspaceOf(record.id) },
    status: 'active',
    tools: SLACK_TOOLS.map(({ name, description }) => ({ name, description })),
    async authorization() {
      const current = await getIntegration(record.id)
      if (!current || current.agentSlug !== record.agentSlug || !['active', 'error'].includes(current.status)) throw new Error('This agent integration is not active')
      return null
    },
    // The connector owns Slack's connection state and reports a revoked token itself.
    async authRequired() {},
    async reportHealth() {},
    serve: request => serveSlackMcp(record.id, record.agentSlug, request),
  }
}
