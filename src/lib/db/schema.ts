import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// Agents - each agent corresponds to a Docker container
// Container status/port are queried from Docker directly (single source of truth)
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt'), // Optional custom system prompt to append
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Sessions - conversations within an agent
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  containerSessionId: text('container_session_id'), // Session ID from container API
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastActivityAt: integer('last_activity_at', { mode: 'timestamp' }),
})

// Messages - stored per session
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  type: text('type', {
    enum: ['user', 'assistant', 'system', 'result'],
  }).notNull(),
  content: text('content', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Tool calls - each assistant message can have multiple tool calls
export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(), // Claude's tool_use_id
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  result: text('result'), // Tool output (can be large)
  isError: integer('is_error', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Agent secrets - environment variables passed to the container
export const agentSecrets = sqliteTable('agent_secrets', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  key: text('key').notNull(), // Display name (e.g., "My API Key")
  envVar: text('env_var').notNull(), // Computed env var name (e.g., "MY_API_KEY")
  value: text('value').notNull(), // The secret value
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Type exports for convenience
export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type ToolCall = typeof toolCalls.$inferSelect
export type NewToolCall = typeof toolCalls.$inferInsert
export type AgentSecret = typeof agentSecrets.$inferSelect
export type NewAgentSecret = typeof agentSecrets.$inferInsert
