import type { LucideIcon } from 'lucide-react'

/**
 * Props passed to custom expanded view components
 */
export interface ToolRendererProps {
  input: unknown
  result?: string | null
  isError?: boolean
  agentSlug?: string
}

/**
 * Props passed to streaming view components
 */
export interface StreamingToolRendererProps {
  partialInput: string
}

/**
 * Configuration for a tool-specific renderer
 */
export interface ToolRenderer {
  /**
   * Human-friendly name to display instead of the raw tool name
   * e.g., "Request Secret" instead of "mcp__user-input__request_secret"
   */
  displayName?: string

  /**
   * Extract a short summary from the input to show in collapsed view
   * Return null to fall back to showing just the tool name
   */
  getSummary?: (input: unknown) => string | null

  /**
   * Custom icon for this tool (optional)
   */
  icon?: LucideIcon

  /**
   * Custom component for the expanded view
   * If not provided, falls back to generic JSON display
   */
  ExpandedView?: React.ComponentType<ToolRendererProps>

  /**
   * Custom component for streaming state
   * If not provided, falls back to generic streaming display
   */
  StreamingView?: React.ComponentType<StreamingToolRendererProps>
}
