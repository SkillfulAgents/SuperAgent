import type { ToolRenderer } from './types'
import { bashRenderer } from './bash'
import { readRenderer } from './read'
import { writeRenderer } from './write'
import { globRenderer } from './glob'
import { grepRenderer } from './grep'
import { webSearchRenderer } from './web-search'
import { webFetchRenderer } from './web-fetch'
import { todoWriteRenderer } from './todo-write'
import { askUserQuestionRenderer } from './ask-user-question'
import { requestSecretRenderer } from './request-secret'
import { requestConnectedAccountRenderer } from './request-connected-account'
import { scheduleTaskRenderer } from './schedule-task'
import { deliverFileRenderer } from './deliver-file'
import { requestFileRenderer } from './request-file'
import { requestRemoteMcpRenderer } from './request-remote-mcp'
import { taskRenderer } from './task'
import {
  browserOpenRenderer,
  browserCloseRenderer,
  browserSnapshotRenderer,
  browserClickRenderer,
  browserFillRenderer,
  browserScrollRenderer,
  browserWaitRenderer,
  browserPressRenderer,
  browserScreenshotRenderer,
  browserSelectRenderer,
  browserHoverRenderer,
  browserRunRenderer,
} from './browser-tools'
import {
  createDashboardRenderer,
  startDashboardRenderer,
  listDashboardsRenderer,
  getDashboardLogsRenderer,
} from './dashboard-tools'

export type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps, CollapsedContentProps } from './types'

/**
 * Registry of tool-specific renderers
 * Keys are tool names (matching toolCall.name)
 */
const toolRenderers: Record<string, ToolRenderer> = {
  // Agent tools
  Task: taskRenderer,

  // Shell/command tools
  Bash: bashRenderer,

  // File operations
  Read: readRenderer,
  Write: writeRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,

  // Web tools
  WebSearch: webSearchRenderer,
  WebFetch: webFetchRenderer,

  // Task management
  TodoWrite: todoWriteRenderer,

  // User interaction
  AskUserQuestion: askUserQuestionRenderer,

  // MCP tools - user input
  'mcp__user-input__request_secret': requestSecretRenderer,
  'mcp__user-input__request_connected_account': requestConnectedAccountRenderer,
  'mcp__user-input__schedule_task': scheduleTaskRenderer,
  'mcp__user-input__deliver_file': deliverFileRenderer,
  'mcp__user-input__request_file': requestFileRenderer,
  'mcp__user-input__request_remote_mcp': requestRemoteMcpRenderer,

  // MCP tools - browser
  'mcp__browser__browser_open': browserOpenRenderer,
  'mcp__browser__browser_close': browserCloseRenderer,
  'mcp__browser__browser_snapshot': browserSnapshotRenderer,
  'mcp__browser__browser_click': browserClickRenderer,
  'mcp__browser__browser_fill': browserFillRenderer,
  'mcp__browser__browser_scroll': browserScrollRenderer,
  'mcp__browser__browser_wait': browserWaitRenderer,
  'mcp__browser__browser_press': browserPressRenderer,
  'mcp__browser__browser_screenshot': browserScreenshotRenderer,
  'mcp__browser__browser_select': browserSelectRenderer,
  'mcp__browser__browser_hover': browserHoverRenderer,
  'mcp__browser__browser_run': browserRunRenderer,

  // MCP tools - dashboards
  'mcp__dashboards__create_dashboard': createDashboardRenderer,
  'mcp__dashboards__start_dashboard': startDashboardRenderer,
  'mcp__dashboards__list_dashboards': listDashboardsRenderer,
  'mcp__dashboards__get_dashboard_logs': getDashboardLogsRenderer,
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
