/**
 * Shared types for tool definitions and user request events.
 */

// ── ToolDefinition interface ─────────────────────────────────────────
// Every tool definition file exports a `*Def` object satisfying this shape.

export interface ToolDefinition {
  displayName: string
  iconName: string
  getSummary: (input: unknown) => string | null
}

// ── formatToolName ───────────────────────────────────────────────────
// Fallback display name for MCP tools that have no custom definition.

export function formatToolName(rawName: string): string {
  const match = rawName.match(/^mcp__(.+?)__(.+)$/)
  if (!match) return rawName

  const [, serverSlug, toolSlug] = match

  const titleCase = (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())

  return `${titleCase(serverSlug)} MCP: ${titleCase(toolSlug)}`
}

// ── UserRequestEvent union ────��──────────────────────────────────────
// Matches the SSE event shapes broadcast by MessagePersister.

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export type UserRequestEvent =
  | {
      type: 'user_question_request'
      toolUseId: string
      questions: Question[]
      agentSlug?: string
    }
  | {
      type: 'secret_request'
      toolUseId: string
      secretName: string
      reason?: string
      agentSlug?: string
    }
  | {
      type: 'file_request'
      toolUseId: string
      description: string
      fileTypes?: string
      agentSlug?: string
    }
  | {
      type: 'file_delivery'
      toolUseId: string
      filePath: string
      description?: string
      agentSlug?: string
    }
  | {
      type: 'connected_account_request'
      toolUseId: string
      toolkit: string
      reason?: string
      agentSlug?: string
    }
  | {
      type: 'remote_mcp_request'
      toolUseId: string
      url: string
      name?: string
      reason?: string
      authHint?: 'oauth' | 'bearer'
      agentSlug?: string
    }
  | {
      type: 'browser_input_request'
      toolUseId: string
      message: string
      requirements: string[]
      agentSlug?: string
    }
  | {
      type: 'script_run_request'
      toolUseId: string
      script: string
      explanation: string
      scriptType: string
      agentSlug?: string
    }
  | {
      type: 'computer_use_request'
      toolUseId: string
      method: string
      params: Record<string, unknown>
      permissionLevel: string
      appName?: string
      agentSlug?: string
    }
  | {
      type: 'tool_status'
      toolUseId: string
      toolName: string
      summary: string
      status: 'running' | 'success' | 'error' | 'cancelled'
      agentSlug?: string
    }
