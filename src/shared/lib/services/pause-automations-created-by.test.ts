import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import * as schema from '../db/schema'

// Real migrated SQLite: the bulk pause must hit exactly the deleted user's
// pending rows and leave everyone else's untouched.
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))
vi.mock('../analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))

import { createScheduledTask, pauseScheduledTasksCreatedBy } from './scheduled-task-service'
import { createWebhookTrigger, pauseWebhookTriggersCreatedBy } from './webhook-trigger-service'

const GONE = 'user_gone'
const ALIVE = 'user_alive'

function taskRow(id: string) {
  return testDb.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, id)).get()!
}
function triggerRow(id: string) {
  return testDb.select().from(schema.webhookTriggers).where(eq(schema.webhookTriggers.id, id)).get()!
}

beforeEach(() => {
  testSqlite = new Database(':memory:')
  testDb = drizzle(testSqlite, { schema })
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  testSqlite?.close()
})

describe('pauseScheduledTasksCreatedBy', () => {
  it('pauses the user’s pending cron tasks, cancels their pending one-time tasks, leaves others alone', async () => {
    const cron = await createScheduledTask({ agentSlug: 'a', scheduleType: 'cron', scheduleExpression: '0 * * * *', prompt: 'p', createdByUserId: GONE })
    const once = await createScheduledTask({ agentSlug: 'a', scheduleType: 'at', scheduleExpression: 'at now + 2 hours', prompt: 'p', createdByUserId: GONE })
    const other = await createScheduledTask({ agentSlug: 'a', scheduleType: 'cron', scheduleExpression: '0 * * * *', prompt: 'p', createdByUserId: ALIVE })
    const legacy = await createScheduledTask({ agentSlug: 'a', scheduleType: 'cron', scheduleExpression: '0 * * * *', prompt: 'p' })

    await expect(pauseScheduledTasksCreatedBy(GONE)).resolves.toBe(2)

    expect(taskRow(cron)).toMatchObject({ status: 'paused', pausedAt: new Date('2026-09-14T12:00:00.000Z') })
    expect(taskRow(once)).toMatchObject({ status: 'cancelled', cancelledAt: new Date('2026-09-14T12:00:00.000Z') })
    expect(taskRow(other).status).toBe('pending')
    expect(taskRow(legacy).status).toBe('pending')
  })

  it('does not touch tasks that are already cancelled or paused', async () => {
    const cron = await createScheduledTask({ agentSlug: 'a', scheduleType: 'cron', scheduleExpression: '0 * * * *', prompt: 'p', createdByUserId: GONE })
    await testDb.update(schema.scheduledTasks).set({ status: 'cancelled' }).where(eq(schema.scheduledTasks.id, cron))

    await expect(pauseScheduledTasksCreatedBy(GONE)).resolves.toBe(0)
    expect(taskRow(cron).status).toBe('cancelled')
  })
})

describe('pauseWebhookTriggersCreatedBy', () => {
  it('pauses the user’s active triggers and leaves others alone', async () => {
    const mine = await createWebhookTrigger({ agentSlug: 'a', composioTriggerId: 'ti_1', connectedAccountId: 'ca_1', triggerType: 'T', prompt: 'p', createdByUserId: GONE })
    const other = await createWebhookTrigger({ agentSlug: 'a', composioTriggerId: 'ti_2', connectedAccountId: 'ca_1', triggerType: 'T', prompt: 'p', createdByUserId: ALIVE })
    const legacy = await createWebhookTrigger({ agentSlug: 'a', composioTriggerId: 'ti_3', connectedAccountId: 'ca_1', triggerType: 'T', prompt: 'p' })

    await expect(pauseWebhookTriggersCreatedBy(GONE)).resolves.toBe(1)

    expect(triggerRow(mine)).toMatchObject({ status: 'paused', pausedAt: new Date('2026-09-14T12:00:00.000Z') })
    expect(triggerRow(other).status).toBe('active')
    expect(triggerRow(legacy).status).toBe('active')
  })

  it('does not reactivate or re-stamp a trigger that is already cancelled', async () => {
    const mine = await createWebhookTrigger({ agentSlug: 'a', composioTriggerId: 'ti_1', connectedAccountId: 'ca_1', triggerType: 'T', prompt: 'p', createdByUserId: GONE })
    await testDb.update(schema.webhookTriggers).set({ status: 'cancelled' }).where(eq(schema.webhookTriggers.id, mine))

    await expect(pauseWebhookTriggersCreatedBy(GONE)).resolves.toBe(0)
    expect(triggerRow(mine).status).toBe('cancelled')
  })
})
