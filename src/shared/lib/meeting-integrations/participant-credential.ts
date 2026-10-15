import { getIntegrationSession } from '../agent-integrations/store'
import { isTerminalMeetingStatus } from './schemas'
import { verifyParticipantToken } from './store'

/**
 * The meeting bot's browser is signed into nothing, yet the participant page
 * it loads is the app: it reads the session, sends spoken requests, mints a
 * Live session and watches the browser stream. In a deployment with accounts
 * those routes want a user. This credential stands in for one, scoped to the
 * one agent and session the meeting belongs to, for as long as the meeting is
 * open.
 *
 * It travels as a cookie the participant bootstrap sets from the page token,
 * so every request the page makes afterwards (fetch, EventSource, WebSocket,
 * `<img>`) carries it without the renderer knowing. The value is the page
 * token itself, prefixed with the meeting id so the lookup is by key: whoever
 * holds the page URL already holds everything this credential grants, which
 * is why what it grants is only what the page needs (`meetingParticipantMayRequest`).
 */
export const MEETING_PARTICIPANT_COOKIE = 'gamut_meeting_participant'

/**
 * The routes a participant credential may reach at all: the meeting's own
 * agent session (messages, stream, files, the browser view; the agent
 * middlewares then confine each to that agent and session) and the voice
 * routes that mint the call's voice session with the person's provider.
 * Everything else is the app, where the bot's browser has no business, so the
 * credential never stands in for the person there.
 */
const PARTICIPANT_ROUTES: readonly RegExp[] = [
  /^\/api\/agents\/[^/]+\/(sessions|files|browser)(\/|$)/,
  /^\/api\/(voice|stt)\//,
]

export function meetingParticipantMayRequest(path: string): boolean {
  return PARTICIPANT_ROUTES.some(route => route.test(path))
}

export interface MeetingParticipantPrincipal {
  meetingId: string
  agentSlug: string
  sessionId: string
  /** The person the meeting was started for; the page acts, and is billed, as them. */
  userId: string
}

export function participantCookieValue(meetingId: string, token: string): string {
  return `${meetingId}.${token}`
}

export function participantCookieHeader(value: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  return `${MEETING_PARTICIPANT_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${options.maxAgeSeconds}; HttpOnly; SameSite=Strict${options.secure ? '; Secure' : ''}`
}

function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) { try { return decodeURIComponent(rest.join('=')) } catch { return null } }
  }
  return null
}

/**
 * The principal behind a request carrying the participant cookie, or null.
 * Valid only while the meeting is open and once its agent session exists: a
 * meeting that ended takes the credential with it.
 */
export async function authenticateMeetingParticipant(cookieHeader: string | null | undefined): Promise<MeetingParticipantPrincipal | null> {
  const value = readCookie(cookieHeader, MEETING_PARTICIPANT_COOKIE)
  if (!value) return null
  const separator = value.indexOf('.')
  if (separator <= 0) return null
  const meeting = await verifyParticipantToken(value.slice(0, separator), value.slice(separator + 1))
  if (!meeting || isTerminalMeetingStatus(meeting.status) || !meeting.createdByUserId) return null
  const sessionId = meeting.sessionId ?? (await getIntegrationSession(meeting.integrationId, meeting.id))?.sessionId
  if (!sessionId) return null
  return { meetingId: meeting.id, agentSlug: meeting.agentSlug, sessionId, userId: meeting.createdByUserId }
}
