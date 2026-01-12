import type { ToolRenderer } from './types'
import { bashRenderer } from './bash'
import { readRenderer } from './read'
import { writeRenderer } from './write'
import { requestSecretRenderer } from './request-secret'

export type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

/**
 * Registry of tool-specific renderers
 * Keys are tool names (matching toolCall.name)
 */
const toolRenderers: Record<string, ToolRenderer> = {
  // Shell/command tools
  Bash: bashRenderer,

  // File operations
  Read: readRenderer,
  Write: writeRenderer,

  // MCP tools - use full name with prefix
  'mcp__user-input__request_secret': requestSecretRenderer,
}

/**
 * Get the renderer for a specific tool, or undefined for fallback
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
  return toolRenderers[toolName]
}

/**
 * Check if a tool has a custom renderer
 */
export function hasCustomRenderer(toolName: string): boolean {
  return toolName in toolRenderers
}
