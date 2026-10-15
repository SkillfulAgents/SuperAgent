import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from '../agents/host-client'

/**
 * The agent's meeting tools. Each one is a call to the host's
 * /api/x-agent/meetings/* routes, which run the meeting family's operations on
 * this agent's own meeting integration and set it up on first use.
 */

const MEETING_MODES = ['voice', 'silent', 'listen'] as const

const meetingSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  platform: z.string(),
  status: z.string(),
  statusDetail: z.string().nullable(),
  botName: z.string(),
  mode: z.string(),
  sessionId: z.string().nullable(),
  context: z.string().nullable(),
  requestedAt: z.number(),
  joinedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
}).loose()
type Meeting = z.infer<typeof meetingSchema>

function describeMeeting(meeting: Meeting): string {
  const lines = [
    `Meeting ${meeting.id} (${meeting.platform}, ${meeting.mode}): ${meeting.status}${meeting.statusDetail ? ` (${meeting.statusDetail})` : ''}`,
    `  Bot name: ${meeting.botName}`,
    `  Requested: ${new Date(meeting.requestedAt).toISOString()}`,
  ]
  if (meeting.sessionId) lines.push(`  Session: ${meeting.sessionId}`)
  if (meeting.joinedAt) lines.push(`  Joined: ${new Date(meeting.joinedAt).toISOString()}`)
  if (meeting.endedAt) lines.push(`  Ended: ${new Date(meeting.endedAt).toISOString()}`)
  return lines.join('\n')
}

function failed(action: string, error: unknown) {
  return textResult(`Failed to ${action}: ${error instanceof XAgentError ? error.message : String(error)}`, true)
}

export const joinMeetingTool = tool(
  'join_meeting',
  `Send this agent into a Zoom, Google Meet or Microsoft Teams call as a participant. Pass the invite link exactly as given (a Zoom link's passcode is part of it), a brief of what the person wants from you in the call, and how to take part:
- voice: speaks when addressed, shows its work on its video tile.
- silent: never speaks; replies go into the meeting chat and onto the tile.
- listen: gives the call nothing; takes notes for the person who sent you, who reads them in the app.
Omit mode to use the integration's default. The call becomes its own session; this session only gets the meeting back, so tell the person the bot is on its way (it may wait to be admitted) and that notes arrive in the meeting's session. The agent's meeting integration is created on first use when this host can run meeting bots; if the result says meetings are unavailable here, say so instead of retrying.`,
  {
    meeting_url: z.string().describe('The invite link, as given'),
    context: z.string().max(4000).optional().describe('What the person wants from you in this call: purpose, what to watch for, what to deliver afterwards'),
    mode: z.enum(MEETING_MODES).optional().describe('voice (default unless the integration says otherwise), silent, or listen'),
  },
  async ({ meeting_url, context, mode }) => {
    try {
      const data = await callHost('meetings/join', { meeting_url, ...(context ? { context } : {}), ...(mode ? { mode } : {}) },
        z.object({ meeting: meetingSchema, integrationId: z.string(), integrationCreated: z.boolean() }))
      const note = data.integrationCreated ? '\nA Meetings integration was created for this agent; its settings (name in calls, default mode, voice, standing instructions) are on the integration page.' : ''
      return textResult(`Bot requested.\n${describeMeeting(data.meeting)}${note}`)
    } catch (error) {
      return failed('join the meeting', error)
    }
  },
)

export const leaveMeetingTool = tool(
  'leave_meeting',
  'Take this agent out of a meeting it is in or on its way into. Pass the meeting id from join_meeting or list_meetings.',
  { meeting_id: z.string().uuid().describe('The meeting id') },
  async ({ meeting_id }) => {
    try {
      const data = await callHost('meetings/leave', { meeting_id }, z.object({ meeting: meetingSchema }))
      return textResult(`Leave requested.\n${describeMeeting(data.meeting)}`)
    } catch (error) {
      return failed('leave the meeting', error)
    }
  },
)

export const listMeetingsTool = tool(
  'list_meetings',
  'Recent and current meetings of this agent, newest first, with their status and session ids.',
  { limit: z.number().int().min(1).max(50).optional().describe('How many to return (default 20)') },
  async ({ limit }) => {
    try {
      const data = await callHost('meetings/list', limit ? { limit } : {}, z.object({ meetings: z.array(meetingSchema) }))
      if (data.meetings.length === 0) return textResult('No meetings yet.')
      return textResult(data.meetings.map(describeMeeting).join('\n\n'))
    } catch (error) {
      return failed('list meetings', error)
    }
  },
)

export const sendMeetingChatTool = tool(
  'send_meeting_chat',
  'Post a text message into the chat of a meeting this agent is in, such as a link. To share a file or show an image, use deliver_file instead. meeting_id may be omitted when the agent is in exactly one call.',
  {
    message: z.string().min(1).max(4096).describe('The text to post'),
    meeting_id: z.string().uuid().optional().describe('Which meeting; the one live meeting when omitted'),
  },
  async ({ message, meeting_id }) => {
    try {
      await callHost('meetings/chat', { message, ...(meeting_id ? { meeting_id } : {}) }, z.object({ sent: z.literal(true) }))
      return textResult('Posted into the meeting chat.')
    } catch (error) {
      return failed('post into the meeting chat', error)
    }
  },
)

export const meetingTools = [joinMeetingTool, leaveMeetingTool, listMeetingsTool, sendMeetingChatTool]
