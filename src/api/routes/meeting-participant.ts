/**
 * Meeting participant endpoints.
 *
 * The meeting bot's browser loads `/meeting/:meetingId?token=…` and asks here
 * which agent session to join, then follows the room's roster. The bot host
 * posts in-call events to the same token-gated path. The one-time token minted
 * at join time is the credential for all of it: the page runs in a browser
 * nobody is signed into, and the host has no app identity. The bootstrap also
 * hands the page a cookie (see participant-credential.ts) that lets it use the
 * ordinary agent routes for its one session in a deployment with accounts.
 * Nothing here answers with provider credentials or the bot handle.
 */
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { agentCatalog } from '@shared/lib/agent-actor'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { getIntegrationSession } from '@shared/lib/agent-integrations/store'
import { getAgentIntegration } from '@shared/lib/services/agent-integration-service'
import { MeetingAgentIntegration, MAX_MEETING_AGE_MS } from '@shared/lib/meeting-integrations/meeting-agent-integration'
import { participantCookieHeader, participantCookieValue } from '@shared/lib/meeting-integrations/participant-credential'
import { meetingRoster } from '@shared/lib/meeting-integrations/roster'
import { isTerminalMeetingStatus } from '@shared/lib/meeting-integrations/schemas'
import { toPublicMeeting, verifyParticipantToken, type MeetingRecord } from '@shared/lib/meeting-integrations/store'
import { limitJsonBody, type LimitedJsonBodyEnv } from '../middleware/limit-json-body'

const router = new Hono<LimitedJsonBodyEnv>()
const query = z.object({ token: z.string().min(1).max(200) })
const ROSTER_PING_MS = 15_000
/** A participant event is a few hundred bytes; anything larger is not one. */
const EVENT_BODY_MAX_BYTES = 16 * 1024

type Authorized = { meeting: MeetingRecord } | { error: string; status: 401 | 404 }
async function authorize(meetingId: string, rawQuery: Record<string, string>): Promise<Authorized> {
  const parsed = query.safeParse(rawQuery)
  if (!parsed.success) return { error: 'Missing participant token', status: 401 }
  const meeting = await verifyParticipantToken(meetingId, parsed.data.token)
  return meeting ? { meeting } : { error: 'Unknown meeting', status: 404 }
}

router.get('/:meetingId', async (c) => {
  c.header('Cache-Control', 'no-store')
  const auth = await authorize(c.req.param('meetingId'), c.req.query())
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  const { meeting } = auth
  if (isTerminalMeetingStatus(meeting.status)) return c.json({ error: 'This meeting has ended' }, 410)
  const integration = await getAgentIntegration(meeting.integrationId)
  if (!integration || integration.status === 'paused') return c.json({ error: 'The meeting integration is not active' }, 409)
  // The agent session is created by the integration manager just after the join
  // request; the bot usually takes longer to get into the call than that takes.
  const sessionId = meeting.sessionId ?? (await getIntegrationSession(meeting.integrationId, meeting.id))?.sessionId
  if (!sessionId) return c.json({ error: 'The agent is still preparing', retryAfterMs: 2000 }, 503)
  const agent = await agentCatalog.get(meeting.agentSlug)
  // The page is only ever loaded over https (the bot is on the internet); the
  // cookie outlives any meeting and dies with the meeting's row regardless.
  c.header('Set-Cookie', participantCookieHeader(participantCookieValue(meeting.id, c.req.query('token')!), { secure: true, maxAgeSeconds: MAX_MEETING_AGE_MS / 1000 }))
  return c.json({
    meeting: toPublicMeeting(meeting),
    agentSlug: meeting.agentSlug,
    agentName: agent?.name ?? meeting.botName,
    sessionId,
  })
})

/** Who is in the call, as a stream of roster snapshots: one now, one per change. */
router.get('/:meetingId/stream', async (c) => {
  const auth = await authorize(c.req.param('meetingId'), c.req.query())
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  const meetingId = auth.meeting.id
  return streamSSE(c, async (stream) => {
    let closed = false
    const finished = new Promise<void>(resolve => {
      const done = () => { closed = true; resolve() }
      stream.onAbort(done)
      c.req.raw.signal.addEventListener('abort', done, { once: true })
    })
    const send = (roster: ReturnType<typeof meetingRoster.get>) => {
      if (!closed) void stream.writeSSE({ event: 'roster', data: JSON.stringify(roster) })
    }
    const unsubscribe = meetingRoster.subscribe(meetingId, send)
    send(meetingRoster.get(meetingId))
    const ping = setInterval(() => { if (!closed) void stream.writeSSE({ event: 'ping', data: '' }) }, ROSTER_PING_MS)
    try { await finished } finally { clearInterval(ping); unsubscribe() }
  })
})

/**
 * The bot host's in-call callback. Hosts retry on anything but 2xx, so once the
 * token checks out this answers 200 even for events the family does not track;
 * only an unknown meeting or a bad token is refused. Both path spellings are
 * registered because Recall requires the trailing slash before the query string.
 */
const receiveEvent = async (c: Context<LimitedJsonBodyEnv>) => {
  const auth = await authorize(c.req.param('meetingId') ?? '', c.req.query())
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  const { meeting } = auth
  const body = c.get('limitedJsonBody')
  const connector = agentIntegrationManager.getConnector(meeting.integrationId)
  if (!(connector instanceof MeetingAgentIntegration)) return c.json({ accepted: false, reason: 'integration not connected' })
  const accepted = await connector.receiveBotEvent(meeting.id, body)
  return c.json({ accepted })
}
router.post('/:meetingId/events/', limitJsonBody(EVENT_BODY_MAX_BYTES), receiveEvent)
router.post('/:meetingId/events', limitJsonBody(EVENT_BODY_MAX_BYTES), receiveEvent)

export default router
