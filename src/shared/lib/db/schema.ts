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

// Proxy tokens - synthetic tokens for agent-to-proxy authentication
export const proxyTokens = sqliteTable('proxy_tokens', {
  id: text('id').primaryKey(),
  agentSlug: text('agent_slug').notNull().unique(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Proxy audit log - structured log of all proxied requests
export const proxyAuditLog = sqliteTable('proxy_audit_log', {
  id: text('id').primaryKey(),
  agentSlug: text('agent_slug').notNull(),
  accountId: text('account_id').notNull(),
  toolkit: text('toolkit').notNull(),
  targetHost: text('target_host').notNull(),
  targetPath: text('target_path').notNull(),
  method: text('method').notNull(),
  statusCode: integer('status_code'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Remote MCP servers registered at app level
export const remoteMcpServers = sqliteTable('remote_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  authType: text('auth_type', { enum: ['none', 'oauth', 'bearer'] }).notNull().default('none'),

  // Auth tokens
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp' }),

  // OAuth metadata (for token refresh)
  oauthTokenEndpoint: text('oauth_token_endpoint'),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecret: text('oauth_client_secret'),
  oauthResource: text('oauth_resource'),

  // Server metadata (cached from discovery)
  toolsJson: text('tools_json'),
  toolsDiscoveredAt: integer('tools_discovered_at', { mode: 'timestamp' }),

  status: text('status', { enum: ['active', 'error', 'auth_required'] }).notNull().default('active'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Junction table: agent → remote MCP mappings
export const agentRemoteMcps = sqliteTable('agent_remote_mcps', {
  id: text('id').primaryKey(),
  agentSlug: text('agent_slug').notNull(),
  remoteMcpId: text('remote_mcp_id').notNull()
    .references(() => remoteMcpServers.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  agentMcpUnique: uniqueIndex('agent_remote_mcps_unique').on(table.agentSlug, table.remoteMcpId),
}))

// MCP audit log
export const mcpAuditLog = sqliteTable('mcp_audit_log', {
  id: text('id').primaryKey(),
  agentSlug: text('agent_slug').notNull(),
  remoteMcpId: text('remote_mcp_id').notNull(),
  remoteMcpName: text('remote_mcp_name').notNull(),
  method: text('method').notNull(),
  requestPath: text('request_path').notNull(),
  statusCode: integer('status_code'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
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
export type ProxyToken = typeof proxyTokens.$inferSelect
export type NewProxyToken = typeof proxyTokens.$inferInsert
export type ProxyAuditLogEntry = typeof proxyAuditLog.$inferSelect
export type NewProxyAuditLogEntry = typeof proxyAuditLog.$inferInsert
export type RemoteMcpServer = typeof remoteMcpServers.$inferSelect
export type NewRemoteMcpServer = typeof remoteMcpServers.$inferInsert
export type AgentRemoteMcp = typeof agentRemoteMcps.$inferSelect
export type NewAgentRemoteMcp = typeof agentRemoteMcps.$inferInsert
export type McpAuditLogEntry = typeof mcpAuditLog.$inferSelect
export type NewMcpAuditLogEntry = typeof mcpAuditLog.$inferInsert
