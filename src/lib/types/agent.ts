/**
 * Agent Types
 *
 * Type definitions for file-based agent storage
 */

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Frontmatter stored in CLAUDE.md
 */
export interface AgentFrontmatter {
  name: string
  description?: string
  createdAt: string // ISO date string
  [key: string]: string | undefined // Allow additional fields
}

/**
 * Full agent configuration from CLAUDE.md (internal use)
 */
export interface AgentConfig {
  slug: string
  frontmatter: AgentFrontmatter
  instructions: string // CLAUDE.md body (system prompt)
}

/**
 * Input for creating a new agent
 */
export interface CreateAgentInput {
  name: string
  description?: string
  instructions?: string
}

/**
 * Input for updating an agent
 */
export interface UpdateAgentInput {
  name?: string
  description?: string
  instructions?: string
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session metadata stored in session-metadata.json
 */
export interface SessionMetadata {
  name?: string
  starred?: boolean
  createdAt?: string // ISO date string - set when session is first created
}

/**
 * Map of session IDs to their metadata
 */
export interface SessionMetadataMap {
  [sessionId: string]: SessionMetadata
}

/**
 * Session info derived from JSONL file + metadata
 */
export interface SessionInfo {
  id: string
  agentSlug: string
  name: string
  createdAt: Date
  lastActivityAt: Date
  messageCount: number
  isActive?: boolean
}

/**
 * Raw message entry from Claude's JSONL format
 */
export interface JsonlMessageEntry {
  uuid: string
  parentUuid: string | null
  type: 'user' | 'assistant'
  sessionId: string
  timestamp: string
  message: {
    role: string
    content: string | ContentBlock[]
    model?: string
    id?: string
    usage?: {
      input_tokens: number
      output_tokens: number
    }
  }
  // Tool result specific fields (present when type is 'user' with tool_result content)
  toolUseResult?: {
    stdout: string
    stderr: string
    interrupted: boolean
    isImage: boolean
  }
  sourceToolAssistantUUID?: string
}

/**
 * File history snapshot entry from JSONL
 */
export interface JsonlFileHistoryEntry {
  type: 'file-history-snapshot'
  messageId: string
  snapshot: {
    messageId: string
    trackedFileBackups: Record<string, unknown>
    timestamp: string
  }
}

/**
 * Union type for all JSONL entry types
 */
export type JsonlEntry = JsonlMessageEntry | JsonlFileHistoryEntry

// ============================================================================
// Content Block Types (from Anthropic API)
// ============================================================================

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

// ============================================================================
// Secret Types
// ============================================================================

/**
 * Agent secret stored in .env file
 */
export interface AgentSecret {
  key: string // Display name: "My API Key"
  envVar: string // Environment variable: "MY_API_KEY"
  value: string // The secret value
}

// ============================================================================
// Default Templates
// ============================================================================

/**
 * Default instructions for new agents
 */
export const DEFAULT_AGENT_INSTRUCTIONS = `# Agent Instructions

You are a helpful AI assistant.

## Preferences

<!-- The agent can learn and note preferences here -->

## Project Notes

<!-- The agent can add notes as it learns about the project -->
`

/**
 * Generate default CLAUDE.md content for a new agent
 */
export function generateDefaultClaudeMd(name: string, description?: string): string {
  const frontmatter: AgentFrontmatter = {
    name,
    createdAt: new Date().toISOString(),
  }
  if (description) {
    frontmatter.description = description
  }

  const lines = [
    '---',
    `name: ${name}`,
  ]

  if (description) {
    lines.push(`description: ${description}`)
  }

  lines.push(`createdAt: ${frontmatter.createdAt}`)
  lines.push('---')
  lines.push('')
  lines.push(DEFAULT_AGENT_INSTRUCTIONS)

  return lines.join('\n')
}
