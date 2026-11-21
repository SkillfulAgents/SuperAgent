import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { chatIntegrations, chatIntegrationAccess, teamsCards } from '../db/schema'
import { eq } from 'drizzle-orm'
import type { AgentIntegrationRecord, IntegrationSessionContext } from '../agent-integrations/types'
import type { TeamsConfig } from './config-schema'
import { TeamsConnector } from './teams-connector'
import { teamsExternalId, teamsParentChatId } from './teams-activity'
import { fetchTeamsFile, uploadTeamsFile } from './teams-files'
import { ChatInputBuilder } from './chat-input'
import { backgroundSettled } from '../background'

let db: AppDatabase
let database: TestDatabase
vi.mock('../db', () => ({ get db() { return db } }))
const microsoft = vi.hoisted(() => ({
  send: vi.fn(), thread: vi.fn(), edit: vi.fn(), remove: vi.fn(), react: vi.fn(), getDoc: vi.fn(), putDoc: vi.fn(), inline: vi.fn(),
}))
vi.mock('./teams-api', () => ({ TeamsApi: class {
  fetchInlineImage = microsoft.inline
  sendActivity = microsoft.send
  sendThreadActivity = microsoft.thread
  updateActivity = microsoft.edit
  deleteActivity = microsoft.remove
  setReaction = microsoft.react
} }))
vi.mock('../agent-actor', async importOriginal => ({
  ...await importOriginal<typeof import('../agent-actor')>(),
  agentRegistry: { get: () => ({ files: { getDoc: microsoft.getDoc, putDoc: microsoft.putDoc } }) },
}))
const tenant = '90fa4b61-4cb4-4bd0-a85f-17301a0d36ab'
const app = 'd7702938-cbc0-4813-b228-95cfc53fbe7f'
const user = 'e849e257-589b-4397-9635-e4e66ae6ba3d'
const colleague = '1883703e-15fa-4e29-b1d7-d953948453e3'
const serviceUrl = 'https://smba.trafficmanager.net/amer/'
const config: TeamsConfig = { tenantId: tenant, appId: app, clientSecret: 'test', deliveryMode: 'https' }
const record = { id: 'installation', agentSlug: 'agent', provider: 'teams', config: JSON.stringify(config) } as AgentIntegrationRecord
const chatId = teamsExternalId('personal', 'a:personal')
const channel = '19:channel@thread.tacv2'
const thread = teamsExternalId('channel', channel, '1000')
const activity = {
  type: 'message', id: '1000', channelId: 'msteams', serviceUrl, text: 'Hello', from: { id: '29:user', name: 'Ada', aadObjectId: user },
  recipient: { id: '28:' + app, name: 'Gamut' }, conversation: { id: 'a:personal', conversationType: 'personal', tenantId: tenant },
  channelData: { tenant: { id: tenant } }, timestamp: '2026-11-01T17:42:53.000Z',
}
const channelActivity = {
  ...activity, conversation: { id: channel + ';messageid=1000', conversationType: 'channel', tenantId: tenant },
  channelData: { channel: { id: channel, name: 'Support' }, tenant: { id: tenant }, replyChain: { id: '1000' } },
  text: '<at>Gamut</at> check this', entities: [{ type: 'mention', text: '<at>Gamut</at>', mentioned: activity.recipient }],
}
let connector: TeamsConnector
let events = vi.fn()
async function open() {
  const connector = new TeamsConnector(config, undefined, record)
  connector.onEvent(events)
  await connector.connect()
  return connector
}
async function allow(id: string) {
  const now = new Date()
  await db.insert(chatIntegrationAccess).values({ id: crypto.randomUUID(), integrationId: record.id, externalChatId: id, status: 'allowed',
    title: 'Approved conversation', firstUserName: 'Ada', requestedAt: now, createdAt: now, updatedAt: now }).run()
}
beforeEach(async () => {
  vi.resetAllMocks()
  database = await createTestDatabase()
  db = database.db
  await db.insert(chatIntegrations).values({ id: record.id, agentSlug: record.agentSlug, provider: 'teams', config: record.config, createdAt: new Date(), updatedAt: new Date() }).run()
  events = vi.fn().mockResolvedValue('accepted')
  microsoft.send.mockResolvedValue('2000')
  microsoft.thread.mockResolvedValue('2000')
  connector = await open()
})
afterEach(async () => {
  await connector.disconnect()
  await backgroundSettled()
  await database.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
function invocation(token: string, data: Record<string, unknown> = {}) {
  return { ...activity, type: 'invoke', name: 'adaptiveCard/action', id: '3000', replyToId: '2000',
    value: { action: { type: 'Action.Execute', verb: 'gamut.respond', data: { token, ...data } } } }
}

describe('Teams conversations and native activities', () => {
  it('restores an authenticated DM destination across connector recreation and prepares display metadata', async () => {
    expect(await connector.acceptActivity(activity)).toBe('accepted')
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ externalId: chatId, payload: expect.objectContaining({
      userId: user, userName: 'Ada', chatName: 'Ada', text: 'Hello', display: expect.objectContaining({ conversationUrl: expect.stringContaining('teams.microsoft.com/l/chat/0/0?') }),
    }) }))
    await connector.disconnect()
    connector = await open()
    await connector.sendMessage(chatId, { text: 'Hi' })
    await connector.startWorking(chatId)
    expect(microsoft.send).toHaveBeenCalledWith(serviceUrl, 'a:personal', { type: 'message', text: 'Hi', textFormat: 'markdown' }, undefined)
    expect(microsoft.send).toHaveBeenCalledWith(serviceUrl, 'a:personal', { type: 'typing' })
  })
  it('rejects identity mismatch and ignores missing mentions, including subsequent channel replies', async () => {
    expect(await connector.acceptActivity({ ...activity, channelData: { tenant: { id: colleague } } })).toBe('rejected')
    expect(await connector.acceptActivity({ ...activity, recipient: { id: '28:' + colleague } })).toBe('rejected')
    expect(await connector.acceptActivity({ ...activity, from: { id: 'anonymous' } })).toBe('rejected')
    await connector.acceptActivity({ ...channelActivity, entities: [] })
    await connector.acceptActivity({ ...channelActivity, entities: [{ type: 'mention', mentioned: { id: colleague } }] })
    expect(events).not.toHaveBeenCalled()
    await connector.acceptActivity(channelActivity)
    await connector.acceptActivity({ ...channelActivity, id: '1001', replyToId: '1000', entities: [] })
    await connector.acceptActivity({ ...channelActivity, id: '1002', replyToId: '1000' })
    expect(events).toHaveBeenCalledTimes(2)
    expect(events.mock.calls.map(([e]) => [e.externalId, e.payload.text])).toEqual([[thread, 'check this'], [thread, 'check this']])
    await connector.sendMessage(thread, { text: 'Reply' })
    expect(microsoft.thread).toHaveBeenCalledWith(serviceUrl, channel, '1000', channel + ';messageid=1000', 'channel', expect.objectContaining({ text: 'Reply' }))
    await connector.sendMessage(teamsParentChatId(thread)!, { text: 'New post' })
    expect(microsoft.send).toHaveBeenCalledWith(serviceUrl, channel, expect.objectContaining({ text: 'New post' }), undefined)
  })
  it('keeps top-level personal messages together and places explicit thread replies in separate sessions', async () => {
    const channelData = { ...activity.channelData, chat: { id: 'a:personal' }, replyChain: { id: '1000' } }
    await connector.acceptActivity({ ...activity, channelData })
    await connector.acceptActivity({ ...activity, id: '1001', channelData })
    expect(events.mock.calls.map(([e]) => e.externalId)).toEqual([chatId, teamsExternalId('personal', 'a:personal', '1000')])
  })
  it('discovers only approved installed destinations and forgets conversations when removed', async () => {
    await connector.acceptActivity(activity)
    await connector.acceptActivity(channelActivity)
    expect((await connector.listChatUsers()).items).toEqual([])
    await allow(chatId)
    await allow(teamsParentChatId(thread)!)
    expect(await connector.resolveDirectChat(user)).toBe(chatId)
    expect(await connector.resolveDirectChat(colleague).catch(e => String(e))).toContain('add the app')
    expect((await connector.listChatChannels()).items).toHaveLength(1)
    await connector.acceptActivity({ ...activity, type: 'installationUpdate', action: 'remove' })
    expect((await connector.listChatUsers()).items).toEqual([])
    await expect(connector.sendMessage(chatId, { text: 'Cancelled' })).rejects.toThrow('no longer available')
  })
  it('removes every channel of an uninstalled team and preserves unrelated personal conversations', async () => {
    const teamId = '19:general@thread.tacv2'
    await connector.acceptActivity(activity)
    await connector.acceptActivity({ ...channelActivity, channelData: { ...channelActivity.channelData, team: { id: teamId } } })
    await allow(chatId)
    await allow(teamsParentChatId(thread)!)
    await connector.acceptActivity({ ...channelActivity, type: 'installationUpdate', action: 'remove-upgrade',
      conversation: { ...channelActivity.conversation, id: teamId }, channelData: { tenant: { id: tenant }, team: { id: teamId } } })
    expect((await connector.listChatChannels()).items).toEqual([])
    expect(await connector.resolveDirectChat(user)).toBe(chatId)
    await expect(connector.sendMessage(thread, { text: 'Old thread' })).rejects.toThrow('no longer available')
  })
  it('edits partial messages, splits long replies, and adds and removes a native eyes reaction', async () => {
    await connector.acceptActivity(activity)
    const event = events.mock.calls[0][0]
    await allow(chatId)
    await connector.acknowledgeInput(event)
    expect(microsoft.react).toHaveBeenCalledWith(serviceUrl, 'a:personal', '1000', '1f440_eyes', true)
    connector.releaseAcknowledgements(chatId)
    await backgroundSettled()
    expect(microsoft.react).toHaveBeenCalledWith(serviceUrl, 'a:personal', '1000', '1f440_eyes', false)
    await connector.sendStreamingUpdate(chatId, 'Partial')
    await connector.sendStreamingUpdate(chatId, 'More', '2000')
    await connector.finalizeStreamingMessage(chatId, '2000', 'a'.repeat(8100))
    expect(microsoft.edit).toHaveBeenCalledWith(serviceUrl, 'a:personal', '2000', expect.objectContaining({ text: 'More' }))
    expect(microsoft.send).toHaveBeenCalledWith(serviceUrl, 'a:personal', expect.objectContaining({ text: 'a'.repeat(100) }), undefined)
  })
})
describe('Teams cards and files', () => {
  it('validates request, sender, scope, card id and access before handing a structured native answer to Gamut', async () => {
    await connector.acceptActivity(activity)
    await connector.sendUserRequestCard(chatId, { type: 'question_request', toolUseId: 'question-1',
      questions: [{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }, { question: 'Why?' }] })
    const [row] = await db.select().from(teamsCards).all()
    expect(await connector.sessionsToRecover()).toEqual([{ externalId: chatId }])
    const press = invocation(row.token, { q0: '1,0', q1: 'Because' })
    expect(microsoft.send.mock.calls.at(-1)?.[2].attachments[0].content.actions[0].type).toBe('Action.Execute')
    for (const attempt of [press, { ...press, from: { ...activity.from, aadObjectId: colleague } }, { ...press, replyToId: 'unknown' }]) {
      expect(await connector.acceptActivity(attempt)).toMatchObject({ body: { statusCode: 400 } })
    }
    await allow(chatId)
    for (const attempt of [
      { ...press, from: { ...activity.from, aadObjectId: colleague } }, { ...press, replyToId: 'other-card' },
      { ...press, conversation: { ...activity.conversation, id: 'other-chat' } }, invocation(row.token, { q0: '9', q1: 'Because' }),
    ]) expect(await connector.acceptActivity(attempt)).toMatchObject({ body: { statusCode: 400 } })
    expect(await connector.acceptActivity(press)).toMatchObject({ body: { statusCode: 200 } })
    expect(events).toHaveBeenCalledWith({ type: 'response', externalId: chatId, requestKind: 'input', requestId: 'question-1', value: { Choose: 'B, A', 'Why?': 'Because' } })
    await connector.deliver({ externalId: chatId } as IntegrationSessionContext, { type: 'request-resolved', requestId: 'question-1', kind: 'question', outcome: 'answered', scope: { agentSlug: 'agent' } })
    expect(await connector.sessionsToRecover()).toEqual([])
    expect(microsoft.edit.mock.calls[0][3].attachments[0].content.actions).toBeUndefined()
    expect(await connector.acceptActivity(press)).toMatchObject({ body: { statusCode: 400 } })
  })
  it('routes Allow/Deny through the pending review and supports the older submit action', async () => {
    await connector.acceptActivity(activity)
    await allow(chatId)
    await connector.sendUserRequestCard(chatId, { type: 'question_request', toolUseId: 'review:review-1:agent', questions: [{ question: 'Read this file?' }] })
    const [row] = await db.select().from(teamsCards).all()
    expect(await connector.acceptActivity(invocation(row.token, { answer: 'perhaps' }))).toMatchObject({ body: { statusCode: 400 } })
    await connector.acceptActivity({ ...activity, replyToId: '2000', value: { token: row.token, answer: 'deny', requestId: 'another-review' } })
    expect(events).toHaveBeenCalledWith({ type: 'response', externalId: chatId, requestKind: 'review', requestId: 'review-1', value: 'deny' })
  })
  it('uploads only the exact bytes offered, after authenticated personal consent, then replaces the card with the actual file', async () => {
    await connector.acceptActivity(activity)
    await allow(chatId)
    const bytes = Buffer.from('contents')
    await connector.sendFile(chatId, bytes, 'report.txt', 'Report', { workspacePath: 'report.txt' })
    const [row] = await db.select().from(teamsCards).all()
    const url = 'https://gamut.sharepoint.com/up?auth=example'
    const consent = { ...activity, type: 'invoke', name: 'fileConsent/invoke', replyToId: '2000',
      value: { action: 'accept', context: { token: row.token }, uploadInfo: { uploadUrl: url, contentUrl: 'https://gamut.sharepoint.com/report.txt', uniqueId: 'item', fileType: 'txt' } } }
    const upload = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', upload)
    microsoft.getDoc.mockResolvedValue(bytes)
    expect(await connector.acceptActivity(consent)).toEqual({ status: 200 })
    expect(upload).not.toHaveBeenCalled()
    const receipt = events.mock.calls.at(-1)![0]
    expect(receipt).toMatchObject({ id: 'teams-file-consent:' + row.token, payload: { kind: 'teams.file-consent' } })
    expect(await connector.handleProviderInput(receipt, { integration: record, externalId: chatId })).toBe(true)
    expect(upload).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'PUT', redirect: 'error', headers: expect.objectContaining({ 'Content-Range': 'bytes 0-7/8' }) }))
    expect(microsoft.edit.mock.calls.at(-1)?.[3].attachments[0]).toMatchObject({ contentType: 'application/vnd.microsoft.teams.card.file.info', name: 'report.txt' })
    expect(await connector.acceptActivity(consent)).toEqual({ status: 403 })
  })
  it('consumes a changed workspace file without sending its new contents or starting an agent turn', async () => {
    await connector.acceptActivity(activity)
    await allow(chatId)
    await connector.sendFile(chatId, Buffer.from('offered'), 'report.txt', undefined, { workspacePath: 'report.txt' })
    const [row] = await db.select().from(teamsCards).all()
    const url = 'https://tenant.sharepoint.com/file'
    const consent = { action: 'accept', context: { token: row.token }, uploadInfo: { uploadUrl: url, contentUrl: url, uniqueId: 'item', fileType: 'txt' } }
    expect(await connector.acceptActivity({ ...activity, type: 'invoke', name: 'fileConsent/invoke', value: consent })).toEqual({ status: 200 })
    microsoft.getDoc.mockResolvedValue(Buffer.from('different'))
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    const receipt = events.mock.calls.at(-1)![0]
    expect(await connector.handleProviderInput(receipt, { integration: record, externalId: chatId })).toBe(true)
    expect(upload).not.toHaveBeenCalled()
    expect(microsoft.edit.mock.calls.at(-1)![3].text).toContain('changed')
  })
  it('accepts Microsoft download info in DMs and prevents redirects to arbitrary destinations', async () => {
    const url = 'https://gamut.sharepoint.com/shared/file'
    const file = { name: 'report.pdf', contentType: 'application/vnd.microsoft.teams.file.download.info', content: { downloadUrl: url } }
    await connector.acceptActivity({ ...activity, text: '', attachments: [file] })
    expect(events.mock.calls[0][0].payload.files).toEqual([{ name: file.name, url }])
    await connector.acceptActivity({ ...activity, text: '', attachments: [{ ...file, content: { downloadUrl: 'http://127.0.0.1/' } }] })
    expect(events).toHaveBeenCalledTimes(1)
    const download = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://unrelated.example/file' } }))
    vi.stubGlobal('fetch', download)
    await expect(fetchTeamsFile(url)).rejects.toThrow('Unrecognized Microsoft')
    expect(download).toHaveBeenCalledTimes(1)
  })
  it('discards offers on decline without touching file bytes or issuing any upload', async () => {
    await connector.acceptActivity(activity)
    await allow(chatId)
    await connector.sendFile(chatId, Buffer.from('offer'), 'private.txt', undefined, { workspacePath: 'private.txt' })
    const [row] = await db.select().from(teamsCards).all()
    const result = await connector.acceptActivity({ ...activity, type: 'invoke', name: 'fileConsent/invoke', replyToId: '2000', value: { action: 'decline', context: { token: row.token } } })
    expect(result).toEqual({ status: 200 })
    await connector.handleProviderInput(events.mock.calls.at(-1)![0], { integration: record, externalId: chatId })
    expect(microsoft.getDoc).not.toHaveBeenCalled()
    expect(await db.select().from(teamsCards).where(eq(teamsCards.token, row.token)).get()).toBeUndefined()
  })
})

describe('Teams delivery boundaries', () => {
  it('downloads a pasted channel image through its authenticated Bot Connector URL and writes the bytes into the workspace', async () => {
    const image = serviceUrl + 'v3/attachments/1234/views/original'
    await connector.acceptActivity({ ...channelActivity, attachments: [
      { contentType: 'image/png', contentUrl: image },
      { contentType: 'text/html', content: '<img src="http://internal/metadata">' },
    ] })
    microsoft.inline.mockResolvedValue(new Response('image bytes'))
    const inbound = events.mock.calls[0][0].payload
    const result = await new ChatInputBuilder(async () => TeamsConnector).buildMessageContent(record, inbound)
    expect(microsoft.inline).toHaveBeenCalledWith(image)
    expect(microsoft.putDoc).toHaveBeenCalledWith(expect.stringMatching(/^uploads\/image-1-\d+\.png$/), Buffer.from('image bytes'))
    expect(result.failedFiles).toEqual([])
    expect(result.text).toContain('/workspace/uploads/')
  })
  it('delivers a shared-scope artifact through an authenticated Gamut download route', async () => {
    vi.stubEnv('AUTH_MODE', 'true')
    vi.stubEnv('HOST_PUBLIC_URL', 'https://gamut.example')
    await connector.acceptActivity(channelActivity)
    await connector.sendFile(thread, Buffer.from('private file'), 'plan.txt', 'Project plan', { workspacePath: '/workspace/Project plans/plan.txt' })
    const action = microsoft.thread.mock.calls.at(-1)?.[5].attachments[0].content.actions[0]
    expect(action).toMatchObject({ type: 'Action.OpenUrl', url: 'https://gamut.example/api/agents/agent/files/Project%20plans/plan.txt' })
    vi.stubEnv('AUTH_MODE', 'false')
    await expect(connector.sendFile(thread, Buffer.from('private file'), 'plan.txt', undefined, { workspacePath: 'plan.txt' })).rejects.toThrow('personal Teams delivery')
  })
  it('binds a shared-conversation card to the current authenticated sender even when a different person began the thread', async () => {
    await connector.acceptActivity(channelActivity)
    await connector.acceptActivity({ ...channelActivity, id: '1003', from: { ...activity.from, aadObjectId: colleague } })
    const route = connector.resolveRoute(events.mock.calls.at(-1)?.[0])
    expect(route.replyTarget.respondentId).toBe(colleague)
    await connector.sendUserRequestCard(thread, { type: 'question_request', toolUseId: 'input-43', questions: [{ question: 'Continue?' }] }, 'session', route.replyTarget.respondentId)
    const [row] = await db.select().from(teamsCards).all()
    expect(row.respondentId).toBe(colleague)
    await allow(teamsParentChatId(thread)!)
    const press = { ...invocation(row.token, { q0: 'Yes' }), conversation: channelActivity.conversation, channelData: channelActivity.channelData }
    expect(await connector.acceptActivity(press)).toMatchObject({ body: { statusCode: 400 } })
    expect(await connector.acceptActivity({ ...press, from: { ...activity.from, aadObjectId: colleague } })).toMatchObject({ body: { statusCode: 200 } })
  })
  it('resumes an interrupted upload at the first missing byte reported by OneDrive', async () => {
    const chunk = 16 * 320 * 1024
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 416 }))
      .mockResolvedValueOnce(Response.json({ nextExpectedRanges: [`${chunk}-`] }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    await uploadTeamsFile('https://tenant.sharepoint.com/upload', Buffer.alloc(chunk + 1))
    expect(fetch.mock.calls[2][1].headers['Content-Range']).toBe(`bytes ${chunk}-${chunk}/${chunk + 1}`)
  })
  it('uploads a large file in ordered OneDrive fragments with byte-accurate ranges', async () => {
    const chunk = 16 * 320 * 1024
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 })).mockResolvedValueOnce(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    await uploadTeamsFile('https://tenant.sharepoint.com/upload', Buffer.alloc(chunk + 1))
    expect(fetch.mock.calls.map(call => call[1].headers['Content-Range'])).toEqual([`bytes 0-${chunk - 1}/${chunk + 1}`, `bytes ${chunk}-${chunk}/${chunk + 1}`])
  })
})
