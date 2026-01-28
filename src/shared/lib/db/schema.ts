import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'

// =============================================================================
// File-Based Refactor: Only connected accounts remain in DB
// Agents, sessions, messages, and secrets are now file-based
// =============================================================================

// Connected accounts - app-level OAuth connections managed by Composio
export const connectedAccounts = sqliteTable('connected_accounts', {
  id: text('id').primaryKey(),
  composioConnectionId: text('composio_connection_id').notNull().unique(),
  toolkitSlug: text('toolkit_slug').notNull(), // e.g., 'gmail', 'slack', 'github'
  displayName: text('display_name').notNull(), // User-friendly label
  status: text('status', { enum: ['active', 'revoked', 'expired'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Agent connected accounts - junction table for agent-to-account mappings
// Note: agentSlug references the agent's directory name, not a DB foreign key
export const agentConnectedAccounts = sqliteTable(
  'agent_connected_accounts',
  {
    id: text('id').primaryKey(),
    agentSlug: text('agent_slug').notNull(), // References agent directory name
    connectedAccountId: text('connected_account_id')
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    agentAccountUnique: uniqueIndex('agent_connected_accounts_unique').on(
      table.agentSlug,
      table.connectedAccountId
    ),
  })
)

// Scheduled tasks - tasks scheduled by agents for future execution
export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey(),
  agentSlug: text('agent_slug').notNull(),

  // Schedule configuration
  scheduleType: text('schedule_type', { enum: ['at', 'cron'] }).notNull(),
  scheduleExpression: text('schedule_expression').notNull(),

  // Task details
  prompt: text('prompt').notNull(),
  name: text('name'),

  // Status: pending, executed, cancelled, failed
  status: text('status', { enum: ['pending', 'executed', 'cancelled', 'failed'] })
    .notNull()
    .default('pending'),

  // Timing
  nextExecutionAt: integer('next_execution_at', { mode: 'timestamp' }).notNull(),
  lastExecutedAt: integer('last_executed_at', { mode: 'timestamp' }),

  // Recurrence
  isRecurring: integer('is_recurring', { mode: 'boolean' }).notNull().default(false),
  executionCount: integer('execution_count').notNull().default(0),

  // Session tracking
  lastSessionId: text('last_session_id'),
  createdBySessionId: text('created_by_session_id'),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
})

// Notifications - user notifications for session events
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['session_complete', 'session_waiting', 'session_scheduled'] }).notNull(),
  sessionId: text('session_id').notNull(),
  agentSlug: text('agent_slug').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  readAt: integer('read_at', { mode: 'timestamp' }),
})

// Type exports for convenience
export type ConnectedAccount = typeof connectedAccounts.$inferSelect
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert
export type AgentConnectedAccount = typeof agentConnectedAccounts.$inferSelect
export type NewAgentConnectedAccount = typeof agentConnectedAccounts.$inferInsert
export type ScheduledTask = typeof scheduledTasks.$inferSelect
export type NewScheduledTask = typeof scheduledTasks.$inferInsert
export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
