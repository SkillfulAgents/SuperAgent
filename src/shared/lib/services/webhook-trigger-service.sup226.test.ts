/**
 * SUP-226 — Webhook polling skips the connected-account owner when the trigger
 * creator lacks a platform auth row.
 *
 * `getDistinctPlatformMemberIdsForActiveTriggers()` collapses the creator/owner
 * candidates with `??` and only resolves a member ID for whichever user `??`
 * picked. When `createdByUserId` is set but that user has no platform
 * `authAccount` row, the function never tries the connected-account owner, so an
 * otherwise-resolvable trigger is dropped from the per-member poll set.
 *
 * Fix: iterate [createdByUserId, ownerUserId] in priority order and add the
 * first candidate that resolves to a platform member ID, so the creator is
 * preferred but the owner is a fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))

vi.mock('../analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

import {
  createWebhookTrigger,
  getDistinctPlatformMemberIdsForActiveTriggers,
} from './webhook-trigger-service'

const NOW = new Date('2026-04-01T12:00:00.000Z')

async function insertUser(id: string) {
  await testDb.insert(schema.user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function insertConnectedAccount(id: string, ownerUserId: string | null) {
  await testDb.insert(schema.connectedAccounts).values({
    id,
    providerConnectionId: `pc_${id}`,
    providerName: 'composio',
    toolkitSlug: 'gmail',
    displayName: 'Gmail',
    status: 'active',
    userId: ownerUserId,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function insertPlatformAccount(userId: string, memberId: string) {
  await testDb.insert(schema.authAccount).values({
    id: `acct_${memberId}`,
    accountId: memberId,
    providerId: 'platform',
    userId,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('SUP-226: getDistinctPlatformMemberIdsForActiveTriggers owner fallback', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sup226-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })

    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(async () => {
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('falls back to the connected-account owner when the creator has no platform member', async () => {
    // Connected account owned by owner_user, who HAS a platform member id.
    await insertUser('owner_user')
    await insertConnectedAccount('ca_owned', 'owner_user')
    await insertPlatformAccount('owner_user', 'sub_owner_member')

    // Trigger created by creator_user, who has NO platform account row.
    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_1',
      connectedAccountId: 'ca_owned',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Handle email',
      createdByUserId: 'creator_user',
    })

    // Before the fix the `??` resolves to creator_user, whose lookup returns
    // null, and the owner is never tried → returns []. The trigger is dropped.
    expect(getDistinctPlatformMemberIdsForActiveTriggers()).toEqual(['sub_owner_member'])
  })

  it('prefers the creator when the creator does have a platform member (creator priority)', async () => {
    await insertUser('owner_user')
    await insertUser('creator_user')
    await insertConnectedAccount('ca_owned', 'owner_user')
    await insertPlatformAccount('owner_user', 'sub_owner_member')
    await insertPlatformAccount('creator_user', 'sub_creator_member')

    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_1',
      connectedAccountId: 'ca_owned',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Handle email',
      createdByUserId: 'creator_user',
    })

    expect(getDistinctPlatformMemberIdsForActiveTriggers()).toEqual(['sub_creator_member'])
  })

  it('resolves the owner when the trigger has no creator at all', async () => {
    await insertUser('owner_user')
    await insertConnectedAccount('ca_owned', 'owner_user')
    await insertPlatformAccount('owner_user', 'sub_owner_member')

    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_1',
      connectedAccountId: 'ca_owned',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Handle email',
      // no createdByUserId
    })

    expect(getDistinctPlatformMemberIdsForActiveTriggers()).toEqual(['sub_owner_member'])
  })

  it('drops triggers when neither creator nor owner resolves to a platform member', async () => {
    // Owner exists but has no platform account row.
    await insertUser('owner_user')
    await insertConnectedAccount('ca_owned', 'owner_user')

    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_1',
      connectedAccountId: 'ca_owned',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Handle email',
      createdByUserId: 'creator_user',
    })

    expect(getDistinctPlatformMemberIdsForActiveTriggers()).toEqual([])
  })
})
