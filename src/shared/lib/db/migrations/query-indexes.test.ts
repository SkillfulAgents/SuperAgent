/**
 * Pins how SQLite answers the hot per-agent reads after migration 0069: which
 * index each one seeks on, and that the ones meant to skip a sort or a table
 * lookup do. The statements are the services' own (captured as they are
 * prepared), so a query that changes shape and falls off its index fails here.
 *
 * The app never runs ANALYZE, so the planner works from the schema alone and
 * an empty database plans exactly like a full one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import type { AppDatabase } from '../drivers/types'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import {
  countNotifications,
  deleteNotificationsBySessionIds,
  getNotificationCounts,
  getSessionIdsWithUnreadMentions,
  getSessionIdsWithUnreadNotifications,
  getUnreadMentionsByAgents,
  getUnreadNotificationsByAgents,
  listNotifications,
  listUnreadNotifications,
  markAllAsRead,
} from '../../services/notification-service'
import {
  listCancelledScheduledTasks,
  listCompletedOneTimeTasks,
  listPendingScheduledTasks,
  listPendingScheduledTasksByAgents,
  listScheduledTasks,
} from '../../services/scheduled-task-service'
import { queryAuditLog } from '../../services/audit-log-service'
import { recentPasswordFills } from '../../browser-vault/vault-service'
import {
  deleteAgentIntegrationSessionsByIntegration,
  getAgentIntegrationSession,
  getLastDisplayName,
  listActiveAgentIntegrationSessions,
  listAgentIntegrationSessions,
} from '../../services/agent-integration-session-service'

interface PreparedQuery { sql: string; params: unknown[] }

let handle: TestDatabase

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
})

afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

/**
 * Runs `work` and returns the query plan of every statement it prepared on
 * `table`, one string per statement, the plan's steps joined with ` | `.
 */
async function plansOf(table: string, work: () => Promise<unknown>): Promise<string[]> {
  // drizzle's session is where every builder and raw statement is prepared, on
  // both drivers; it has no public hook, so the test reaches for it by name.
  const session = (testDb as unknown as { session: { prepareQuery(query: PreparedQuery, ...rest: unknown[]): unknown } }).session
  const spy = vi.spyOn(session, 'prepareQuery')
  await work()
  const prepared = spy.mock.calls.map(([query]) => query)
  spy.mockRestore()

  const plans: string[] = []
  for (const query of prepared) {
    let next = 0
    const literal = (value: unknown) => typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value)
    const text = query.sql.replace(/\?/g, () => literal(query.params[next++]))
    const steps = await testDb.all<{ detail: string }>(sql.raw(`EXPLAIN QUERY PLAN ${text}`))
    const plan = steps.map((step) => step.detail).join(' | ')
    if (plan.includes(` ${table} `) || plan.endsWith(` ${table}`)) plans.push(plan)
  }
  expect(plans.length, `no statement on ${table} was prepared`).toBeGreaterThan(0)
  return plans
}

const VIEWER = 'user-1'
const AGENTS = ['agent-a', 'agent-b', 'agent-c']

describe('notifications indexes', () => {
  const byTime = 'SEARCH notifications USING INDEX notifications_agent_created_at_idx (agent_slug=?)'
  const covering = 'SEARCH notifications USING COVERING INDEX notifications_agent_read_type_idx'

  it('lists a viewer\'s notifications along (agent_slug, created_at)', async () => {
    expect(await plansOf('notifications', () => listNotifications(50, VIEWER))).toEqual([expect.stringContaining(byTime)])
    expect(await plansOf('notifications', () => listNotifications(50, VIEWER, 100, ['session_complete'])))
      .toEqual([expect.stringContaining(byTime)])
  })

  it('counts a viewer\'s notifications from the index alone', async () => {
    for (const work of [
      () => getNotificationCounts(VIEWER),
      () => countNotifications(VIEWER),
      () => countNotifications(VIEWER, ['session_complete']),
    ]) {
      expect(await plansOf('notifications', work)).toEqual([expect.stringContaining(`${covering} (agent_slug=?)`)])
    }
    // Local mode has no agent filter: still no table lookups, on a scan of the index.
    expect(await plansOf('notifications', () => getNotificationCounts()))
      .toEqual([expect.stringContaining('SCAN notifications USING COVERING INDEX notifications_agent_read_type_idx')])
  })

  it('answers the unread dots from the index alone', async () => {
    const unreadOfType = `${covering} (agent_slug=? AND is_read=? AND type=?`
    expect(await plansOf('notifications', () => getSessionIdsWithUnreadNotifications('agent-a', VIEWER)))
      .toEqual([expect.stringContaining(unreadOfType)])
    expect(await plansOf('notifications', () => getUnreadNotificationsByAgents(AGENTS, VIEWER)))
      .toEqual([expect.stringContaining(unreadOfType)])
    expect(await plansOf('notifications', () => getSessionIdsWithUnreadMentions('agent-a', VIEWER)))
      .toEqual([expect.stringContaining(unreadOfType)])
    expect(await plansOf('notifications', () => getUnreadMentionsByAgents(AGENTS, VIEWER)))
      .toEqual([expect.stringContaining(unreadOfType)])
  })

  it('still seeks on the (agent_slug, is_read) prefix the replaced index gave', async () => {
    const prefix = 'notifications_agent_read_type_idx (agent_slug=? AND is_read=?)'
    expect(await plansOf('notifications', () => listUnreadNotifications(50, VIEWER))).toEqual([expect.stringContaining(prefix)])
    expect(await plansOf('notifications', () => markAllAsRead(VIEWER))).toEqual([expect.stringContaining(prefix)])
    const [byAgent] = await plansOf('notifications', () => deleteNotificationsBySessionIds('agent-a', ['s1', 's2']))
    expect(byAgent).toContain('SEARCH notifications USING')
    expect(byAgent).toContain('(agent_slug=?')
  })
})

describe('scheduled_tasks index', () => {
  const index = 'SEARCH scheduled_tasks USING INDEX scheduled_tasks_agent_slug_status_idx'

  it('reads one agent\'s tasks without scanning the table', async () => {
    expect(await plansOf('scheduled_tasks', () => listScheduledTasks('agent-a'))).toEqual([`${index} (agent_slug=?)`])
  })

  it('seeks on agent and status for the status-filtered reads', async () => {
    for (const work of [
      () => listPendingScheduledTasks('agent-a'),
      () => listPendingScheduledTasksByAgents(AGENTS),
      () => listCancelledScheduledTasks('agent-a'),
      () => listCompletedOneTimeTasks('agent-a'),
    ]) {
      expect(await plansOf('scheduled_tasks', work)).toEqual([expect.stringContaining(`${index} (agent_slug=? AND status=?)`)])
    }
  })
})

describe('audit_log index', () => {
  it('reads an account\'s recent fills as a time range of its object, with no sort', async () => {
    expect(await plansOf('audit_log', () => recentPasswordFills('account-1', 86_400_000)))
      .toEqual(['SEARCH audit_log USING INDEX audit_log_object_created_at_idx (object=? AND created_at>?)'])
  })

  it('pages an object filter newest first with no sort, and counts it from the index', async () => {
    expect(await plansOf('audit_log', () => queryAuditLog({ object: 'agent' }))).toEqual([
      'SEARCH audit_log USING INDEX audit_log_object_created_at_idx (object=?)',
      'SEARCH audit_log USING COVERING INDEX audit_log_object_created_at_idx (object=?)',
    ])
  })
})

describe('chat_integration_sessions index', () => {
  const index = 'SEARCH chat_integration_sessions USING INDEX chat_integration_sessions_integration_chat_idx'

  it('finds a chat\'s session by integration and chat', async () => {
    for (const work of [
      () => getAgentIntegrationSession('integration-1', 'chat-1'),
      () => getLastDisplayName('integration-1', 'chat-1'),
    ]) {
      expect(await plansOf('chat_integration_sessions', work))
        .toEqual([expect.stringContaining(`${index} (integration_id=? AND external_chat_id=?)`)])
    }
  })

  it('still serves the per-integration reads on the integration_id prefix', async () => {
    for (const work of [
      () => listAgentIntegrationSessions('integration-1'),
      () => listActiveAgentIntegrationSessions('integration-1'),
    ]) {
      expect(await plansOf('chat_integration_sessions', work)).toEqual([`${index} (integration_id=?)`])
    }
    const [deletion] = await plansOf('chat_integration_sessions', () => deleteAgentIntegrationSessionsByIntegration('integration-1'))
    expect(deletion).toContain('chat_integration_sessions_integration_chat_idx (integration_id=?)')
  })
})
