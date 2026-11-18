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
 * The requests a participant credential may make at all, which is what the
 * participant page makes: reading its own agent session (messages, stream,
 * media; the agent middlewares then confine it to that agent and that
 * session), sending a message into it and interrupting it (the two writes a
 * conversation needs), reading the agent's files and the browser view's
 * status, and the voice routes that mint the call's voice session with the
 * person's provider. No other write under the session (no fork, no capability
 * review, no account provisioning), nothing sessionless that writes, no
 * browser actions. Everything else is the app, where the bot's browser has no
 * business, so the credential never stands in for the person there.
 */
const PARTICIPANT_REQUESTS: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ['GET', 'HEAD'], path: /^\/api\/agents\/[^/]+\/sessions\/[^/]+(\/|$)/ },
  { methods: ['POST'], path: /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/(messages|interrupt)$/ },
  { methods: ['GET', 'HEAD'], path: /^\/api\/agents\/[^/]+\/files\// },
  { methods: ['GET', 'HEAD'], path: /^\/api\/agents\/[^/]+\/browser\/status$/ },
  { methods: ['GET', 'HEAD', 'POST', 'DELETE'], path: /^\/api\/(voice|stt)\// },
]

export function meetingParticipantMayRequest(method: string, path: string): boolean {
  return PARTICIPANT_REQUESTS.some(rule => rule.path.test(path) && rule.methods.includes(method.toUpperCase()))
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
