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

// Type exports for convenience
export type ConnectedAccount = typeof connectedAccounts.$inferSelect
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert
export type AgentConnectedAccount = typeof agentConnectedAccounts.$inferSelect
export type NewAgentConnectedAccount = typeof agentConnectedAccounts.$inferInsert
