import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { joinMeetingTool, leaveMeetingTool, listMeetingsTool, sendMeetingChatTool, meetingTools } from './meeting-tools'

type Result = { content: Array<{ text: string }>; isError?: boolean }
const run = (tool: unknown, input: unknown) => (tool as { execute(input: unknown): Promise<Result> }).execute(input)
const meeting = { id: '7b1d1a2e-1111-4222-8333-444455556666', integrationId: 'int', meetingUrl: 'https://zoom.us/j/1', platform: 'zoom', status: 'requested', statusDetail: null, botName: 'Ada', mode: 'listen', sessionId: 'session-9', context: 'Take notes', requestedAt: 1_700_000_000_000, joinedAt: null, endedAt: null, recordingRetainedUntil: null }

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  fetchMock = vi.fn(async () => Response.json({ meeting, integrationId: 'int', integrationCreated: true }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

const sentBody = () => JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
const sentUrl = () => (fetchMock.mock.calls[0] as unknown as [string])[0]

describe('join_meeting', () => {
  it('asks the host to join with the link, brief and mode, and tells the agent what happened', async () => {
    const result = await run(joinMeetingTool, { meeting_url: 'https://zoom.us/j/1?pwd=x', context: 'Take notes', mode: 'listen' })
    expect(sentUrl()).toBe('https://host/api/x-agent/meetings/join')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token' }) })
    expect(sentBody()).toEqual({ meeting_url: 'https://zoom.us/j/1?pwd=x', context: 'Take notes', mode: 'listen' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain(`Meeting ${meeting.id} (zoom, listen): requested`)
    expect(result.content[0].text).toContain('Session: session-9')
    expect(result.content[0].text).toContain('A Meetings integration was created for this agent')
  })
  it('leaves optional fields out and says nothing about setup when the installation already existed', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ meeting: { ...meeting, statusDetail: 'Waiting to be admitted', status: 'waiting_room' }, integrationId: 'int', integrationCreated: false }))
    const result = await run(joinMeetingTool, { meeting_url: 'https://meet.google.com/abc-defg-hij' })
    expect(sentBody()).toEqual({ meeting_url: 'https://meet.google.com/abc-defg-hij' })
    expect(result.content[0].text).toContain('waiting_room (Waiting to be admitted)')
    expect(result.content[0].text).not.toContain('integration was created')
  })
  it('hands the host\'s refusal to the agent as an error it can relay', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Meetings are unavailable on this host: it needs a public https address (HOST_PUBLIC_URL) and a Platform connection or a Recall.ai key.' }, { status: 400 }))
    const result = await run(joinMeetingTool, { meeting_url: 'https://zoom.us/j/1' })
    expect(result).toMatchObject({ isError: true, content: [{ text: 'Failed to join the meeting: Meetings are unavailable on this host: it needs a public https address (HOST_PUBLIC_URL) and a Platform connection or a Recall.ai key.' }] })
  })
})

describe('leave_meeting, list_meetings and send_meeting_chat', () => {
  it('leaves by meeting id', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ meeting: { ...meeting, status: 'ended', endedAt: 1_700_000_100_000 } }))
    const result = await run(leaveMeetingTool, { meeting_id: meeting.id })
    expect(sentUrl()).toBe('https://host/api/x-agent/meetings/leave')
    expect(sentBody()).toEqual({ meeting_id: meeting.id })
    expect(result.content[0].text).toMatch(/^Leave requested\.\nMeeting .*: ended/)
    expect(result.content[0].text).toContain('Ended: 2023-11-14T22:15:00.000Z')
  })
  it('lists meetings, newest first as the host returns them, and says when there are none', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ meetings: [meeting, { ...meeting, id: '7b1d1a2e-1111-4222-8333-444455557777', status: 'ended' }] }))
    const result = await run(listMeetingsTool, { limit: 5 })
    expect(sentUrl()).toBe('https://host/api/x-agent/meetings/list')
    expect(sentBody()).toEqual({ limit: 5 })
    expect(result.content[0].text.split('\n\n')).toHaveLength(2)
    fetchMock.mockResolvedValueOnce(Response.json({ meetings: [] }))
    expect((await run(listMeetingsTool, {})).content[0].text).toBe('No meetings yet.')
  })
  it('posts into the meeting chat, with or without a meeting id', async () => {
    fetchMock.mockResolvedValue(Response.json({ sent: true }))
    expect((await run(sendMeetingChatTool, { message: 'https://doc', meeting_id: meeting.id })).content[0].text).toBe('Posted into the meeting chat.')
    expect(sentBody()).toEqual({ message: 'https://doc', meeting_id: meeting.id })
    await run(sendMeetingChatTool, { message: 'hello' })
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body)).toEqual({ message: 'hello' })
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Pass meeting_id: this agent has several meeting integrations.' }, { status: 400 }))
    expect(await run(sendMeetingChatTool, { message: 'hello' })).toMatchObject({ isError: true, content: [{ text: 'Failed to post into the meeting chat: Pass meeting_id: this agent has several meeting integrations.' }] })
  })
  it('exposes exactly the four meeting operations', () => {
    expect(meetingTools.map(tool => (tool as unknown as { name: string }).name)).toEqual(['join_meeting', 'leave_meeting', 'list_meetings', 'send_meeting_chat'])
  })
})
