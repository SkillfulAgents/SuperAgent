import { and, desc, eq, inArray } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { db } from '../db'
import { agentIntegrationMeetings, type AgentIntegrationMeeting } from '../db/schema'
import { changesOf } from '../db/batch'
import { meetingPlatformSchema, type MeetingPlatform } from './meeting-url'
import { meetingStatusSchema, meetingModeSchema, DEFAULT_MEETING_MODE, TERMINAL_MEETING_STATUSES, isTerminalMeetingStatus, MEETING_RECORDING_RETENTION_HOURS, type MeetingMode, type MeetingStatus, type PublicMeeting } from './schemas'

export type MeetingRecord = Omit<AgentIntegrationMeeting, 'status' | 'platform' | 'mode'> & { status: MeetingStatus; platform: MeetingPlatform; mode: MeetingMode }

function fromRow(row: AgentIntegrationMeeting): MeetingRecord {
  // A mode this build does not know (a newer row) reads as the default rather than failing the list.
  const mode = meetingModeSchema.safeParse(row.mode)
  return { ...row, status: meetingStatusSchema.parse(row.status), platform: meetingPlatformSchema.parse(row.platform), mode: mode.success ? mode.data : DEFAULT_MEETING_MODE }
}

export function toPublicMeeting(meeting: MeetingRecord): PublicMeeting {
  return {
    id: meeting.id, integrationId: meeting.integrationId, meetingUrl: meeting.meetingUrl, platform: meeting.platform,
    status: meeting.status, statusDetail: meeting.statusDetail, botName: meeting.botName, mode: meeting.mode, sessionId: meeting.sessionId,
    context: meeting.context, requestedAt: meeting.requestedAt.getTime(),
    joinedAt: meeting.joinedAt?.getTime() ?? null, endedAt: meeting.endedAt?.getTime() ?? null,
    recordingRetainedUntil: meeting.status === 'ended' && meeting.joinedAt && meeting.endedAt
      ? meeting.endedAt.getTime() + MEETING_RECORDING_RETENTION_HOURS * 60 * 60 * 1000 : null,
  }
}

/** The page token travels only in the bot's page URL; the row keeps its hash. */
export function hashParticipantToken(token: string): string { return createHash('sha256').update(token).digest('hex') }
export function mintParticipantToken(): string { return randomBytes(24).toString('base64url') }

export async function createMeeting(input: {
  integrationId: string; agentSlug: string; meetingUrl: string; platform: MeetingPlatform; botName: string; mode?: MeetingMode
  context?: string; createdByUserId?: string | null; participantToken: string
}): Promise<MeetingRecord> {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(), integrationId: input.integrationId, agentSlug: input.agentSlug, meetingUrl: input.meetingUrl,
    platform: input.platform, botName: input.botName, mode: input.mode ?? DEFAULT_MEETING_MODE, botId: null, status: 'requested', statusDetail: null, sessionId: null,
    context: input.context ?? null, participantTokenHash: hashParticipantToken(input.participantToken),
    createdByUserId: input.createdByUserId ?? null, requestedAt: now, joinedAt: null, endedAt: null, updatedAt: now,
  }
  await db.insert(agentIntegrationMeetings).values(row).run()
  return fromRow(row)
}

export async function getMeeting(id: string): Promise<MeetingRecord | null> {
  const row = await db.select().from(agentIntegrationMeetings).where(eq(agentIntegrationMeetings.id, id)).get()
  return row ? fromRow(row) : null
}

export async function listMeetings(integrationId: string, limit = 20): Promise<MeetingRecord[]> {
  const rows = await db.select().from(agentIntegrationMeetings).where(eq(agentIntegrationMeetings.integrationId, integrationId))
    .orderBy(desc(agentIntegrationMeetings.requestedAt)).limit(limit).all()
  return rows.map(fromRow)
}

/** Meetings whose bot may still be in or on its way into a call. */
export async function listOpenMeetings(integrationId: string): Promise<MeetingRecord[]> {
  const open = meetingStatusSchema.options.filter(status => !isTerminalMeetingStatus(status))
  const rows = await db.select().from(agentIntegrationMeetings)
    .where(and(eq(agentIntegrationMeetings.integrationId, integrationId), inArray(agentIntegrationMeetings.status, open)))
    .orderBy(desc(agentIntegrationMeetings.requestedAt)).all()
  return rows.map(fromRow)
}

export async function setMeetingBot(id: string, botId: string): Promise<void> {
  await db.update(agentIntegrationMeetings).set({ botId, updatedAt: new Date() }).where(eq(agentIntegrationMeetings.id, id)).run()
}

export async function setMeetingSession(id: string, sessionId: string): Promise<void> {
  await db.update(agentIntegrationMeetings).set({ sessionId, updatedAt: new Date() }).where(eq(agentIntegrationMeetings.id, id)).run()
}

/**
 * Record a lifecycle transition. A terminal state is final: a late poll or a
 * duplicate webhook cannot reopen an ended meeting. Returns the row only when
 * something changed, so callers react to transitions, not repeats.
 */
export async function transitionMeeting(id: string, status: MeetingStatus, detail?: string): Promise<MeetingRecord | null> {
  const current = await getMeeting(id)
  if (!current || isTerminalMeetingStatus(current.status)) return null
  if (current.status === status && (detail ?? null) === current.statusDetail) return null
  const now = new Date()
  const result = await db.update(agentIntegrationMeetings).set({
    status, statusDetail: detail ?? null, updatedAt: now,
    ...(status === 'in_call' && !current.joinedAt ? { joinedAt: now } : {}),
    ...(isTerminalMeetingStatus(status) ? { endedAt: now } : {}),
  }).where(and(eq(agentIntegrationMeetings.id, id), eq(agentIntegrationMeetings.status, current.status))).run()
  if (changesOf(result) === 0) return null
  return getMeeting(id)
}

export async function verifyParticipantToken(id: string, token: string): Promise<MeetingRecord | null> {
  const meeting = await getMeeting(id)
  if (!meeting || meeting.participantTokenHash !== hashParticipantToken(token)) return null
  return meeting
}

export { TERMINAL_MEETING_STATUSES }
