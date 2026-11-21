import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db } from '../db'
import { batch } from '../db/batch'
import { teamsCards, teamsConversationReferences as refs } from '../db/schema'
import type { TeamsActivity } from './teams-activity'
import { teamsExternalId, teamsScopeId, teamsThreadRoot } from './teams-activity'
import { serializeTeamsCard, teamsCardPayload, type TeamsCard } from './teams-card-schema'

const ttl = 7 * 24 * 60 * 60 * 1000
export class TeamsConversationStore {
  constructor(readonly integrationId: string, private tenantId: string, private appId: string) {}

  async remember(a: TeamsActivity, sender: string, displayName?: string): Promise<void> {
    const scopeType = a.conversation.conversationType
    const scopeId = teamsScopeId(a)
    const threadRoot = teamsThreadRoot(a)
    const row = {
      integrationId: this.integrationId, tenantId: this.tenantId, appId: this.appId, scopeType, scopeId,
      originatorId: sender, displayName, serviceUrl: a.serviceUrl, teamId: a.channelData?.team?.id ?? a.channelData?.teamsTeamId,
      externalId: teamsExternalId(scopeType, scopeId), conversationId: threadRoot ? scopeId : a.conversation.id,
    }
    const rows = threadRoot ? [row, { ...row, externalId: teamsExternalId(scopeType, scopeId, threadRoot), conversationId: a.conversation.id, threadRoot }] : [row]
    // Keep the original conversation requester on refresh. A later participant
    // posting a mention must not acquire the right to press their cards.
    await batch(rows.map(ref => db.insert(refs).values(ref).onConflictDoUpdate({
      target: [refs.integrationId, refs.externalId], set: { serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, teamId: ref.teamId, displayName },
      setWhere: and(eq(refs.tenantId, this.tenantId), eq(refs.appId, this.appId)),
    })))
  }

  async reference(chatId: string) {
    const row = await db.select().from(refs).where(and(eq(refs.integrationId, this.integrationId),
      eq(refs.externalId, chatId), eq(refs.tenantId, this.tenantId), eq(refs.appId, this.appId))).get()
    if (!row) throw new Error('Teams conversation is no longer available')
    return row
  }

  async destinations(personal: boolean, userId?: string) {
    return db.select({ id: refs.externalId, userId: refs.originatorId, name: refs.displayName }).from(refs)
      .where(and(eq(refs.integrationId, this.integrationId), eq(refs.tenantId, this.tenantId), eq(refs.appId, this.appId),
        personal ? eq(refs.scopeType, 'personal') : inArray(refs.scopeType, ['groupChat', 'channel']), isNull(refs.threadRoot),
        userId ? eq(refs.originatorId, userId) : undefined))
      .orderBy(asc(refs.displayName), asc(refs.externalId)).limit(201).all()
  }

  async uninstall(scopeId: string, teamId?: string) {
    const match = and(eq(refs.integrationId, this.integrationId), eq(refs.tenantId, this.tenantId), eq(refs.appId, this.appId),
      or(eq(refs.scopeId, scopeId), teamId ? eq(refs.teamId, teamId) : undefined))
    await batch([
      db.delete(teamsCards).where(and(eq(teamsCards.integrationId, this.integrationId), inArray(teamsCards.externalId, db.select({ id: refs.externalId }).from(refs).where(match)))),
      db.delete(refs).where(match),
    ])
  }

  async saveCard(chatId: string, token: string, requestId: string | undefined, payload: TeamsCard, respondentId: string) {
    await batch([
      db.delete(teamsCards).where(lt(teamsCards.createdAt, new Date(Date.now() - ttl))),
      db.insert(teamsCards).values({ token, integrationId: this.integrationId, externalId: chatId, requestId, respondentId,
        createdAt: new Date(), payload: serializeTeamsCard(payload) }),
    ])
  }
  async bindCard(token: string, activityId: string) {
    await db.update(teamsCards).set({ activityId }).where(eq(teamsCards.token, token)).run()
  }
  async card(token: string) {
    const row = await db.select().from(teamsCards).where(and(eq(teamsCards.integrationId, this.integrationId), eq(teamsCards.token, token))).get()
    if (!row || row.createdAt.getTime() <= Date.now() - ttl) return
    try { return { ...row, card: teamsCardPayload.parse(JSON.parse(row.payload)) } }
    catch { throw new Error('Stored Teams request card is invalid') }
  }
  async pendingRequestChats() {
    return db.selectDistinct({ externalId: teamsCards.externalId }).from(teamsCards).where(and(
      eq(teamsCards.integrationId, this.integrationId), isNotNull(teamsCards.requestId), gt(teamsCards.createdAt, new Date(Date.now() - ttl)),
    )).all()
  }
  async requestCards(chatId: string, requestId?: string) {
    return await db.select().from(teamsCards).where(and(eq(teamsCards.integrationId, this.integrationId), eq(teamsCards.externalId, chatId),
      requestId ? eq(teamsCards.requestId, requestId) : undefined)).all()
  }
  async updateCardPayload(token: string, oldPayload: string, payload: TeamsCard) {
    const updated = await db.update(teamsCards).set({ payload: serializeTeamsCard(payload) })
      .where(and(eq(teamsCards.token, token), eq(teamsCards.payload, oldPayload))).returning({ token: teamsCards.token }).get()
    return !!updated
  }
  async forget(token: string) {
    await db.delete(teamsCards).where(eq(teamsCards.token, token)).run()
  }
}
