import { Hono } from 'hono'
import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { appendVoiceTranscript, startVoiceTranscript } from '@shared/lib/voice/transcripts'
import { transcriptSessionIdSchema, voiceSpeechBatchSchema, voiceTranscriptStartSchema } from '@shared/lib/voice/transcript-schema'
import { nameVoiceSpeech } from '@shared/lib/meeting-integrations/transcript-speakers'
import { Authenticated, ResolveAgent, AgentUser, getAgentId } from '../middleware/auth'
import { limitJsonBody, type LimitedJsonBodyEnv } from '../middleware/limit-json-body'

const router = new Hono<LimitedJsonBodyEnv>()
router.use('*', Authenticated(), ResolveAgent(), AgentUser(), limitJsonBody(64 * 1024))
router.use('*', async (c, next) => {
  const parsed = transcriptSessionIdSchema.safeParse(c.req.param('sessionId'))
  if (!parsed.success) return c.json({ error: 'Invalid session id' }, 400)
  if (!await agentRegistry.get(getAgentId(c)).sessions.isKnown(parsed.data)) return c.json({ error: 'Session not found' }, 404)
  await next()
})
router.post('/', async c => {
  const parsed = voiceTranscriptStartSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid voice activation' }, 400)
  return c.json(await startVoiceTranscript(agentRegistry.get(getAgentId(c)), c.req.param('sessionId')!, parsed.data.id))
})
router.post('/:index/:transcriptId', async c => {
  const parsed = voiceSpeechBatchSchema.safeParse(c.get('limitedJsonBody'))
  const index = z.coerce.number().int().nonnegative().safeParse(c.req.param('index'))
  if (!parsed.success || !index.success || !z.uuid().safeParse(c.req.param('transcriptId')).success) return c.json({ error: 'Invalid speech batch' }, 400)
  const sessionId = c.req.param('sessionId')!
  const agentSlug = getAgentId(c)
  const batch = parsed.data
  const shift = Date.now() - batch.sentAt
  const pieces = await nameVoiceSpeech(agentSlug, sessionId, batch.pieces.map(piece => ({ ...piece, at: piece.at + shift })))
  const result = await appendVoiceTranscript(agentRegistry.get(agentSlug), sessionId, index.data, c.req.param('transcriptId'), pieces)
  if (!result) return c.json({ error: 'Voice transcript not found' }, 404)
  return c.json({ accepted: true })
})
export default router
