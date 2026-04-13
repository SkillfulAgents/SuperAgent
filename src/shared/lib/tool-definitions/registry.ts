/**
 * Tool definition registry.
 *
 * Maps tool names to their definitions. Usable from both backend
 * (MessagePersister, ChatIntegrationManager) and renderer.
 */

import type { ToolDefinition } from './types'
import { bashDef } from './bash'
import { readDef } from './read'
import { writeDef } from './write'
import { globDef } from './glob'
import { grepDef } from './grep'
import { webSearchDef } from './web-search'
import { webFetchDef } from './web-fetch'
import { todoWriteDef } from './todo-write'
import { taskDef } from './task'
import { askUserQuestionDef } from './ask-user-question'
import { requestSecretDef } from './request-secret'
import { requestConnectedAccountDef } from './request-connected-account'
import { scheduleTaskDef } from './schedule-task'
import { deliverFileDef } from './deliver-file'
import { requestFileDef } from './request-file'
import { requestRemoteMcpDef } from './request-remote-mcp'
import { requestScriptRunDef } from './request-script-run'
import { requestBrowserInputDef } from './request-browser-input'
import {
  browserOpenDef,
  browserCloseDef,
  browserSnapshotDef,
  browserClickDef,
  browserFillDef,
  browserScrollDef,
  browserWaitDef,
  browserPressDef,
  browserScreenshotDef,
  browserSelectDef,
  browserHoverDef,
  browserRunDef,
} from './browser-tools'
import {
  createDashboardDef,
  startDashboardDef,
  listDashboardsDef,
  getDashboardLogsDef,
} from './dashboard-tools'

const definitions: Record<string, ToolDefinition> = {
  // Agent tools
  Task: taskDef,

  // Shell/command tools
  Bash: bashDef,

  // File operations
  Read: readDef,
  Write: writeDef,
  Glob: globDef,
  Grep: grepDef,

  // Web tools
  WebSearch: webSearchDef,
  WebFetch: webFetchDef,

  // Task management
  TodoWrite: todoWriteDef,

  // User interaction
  AskUserQuestion: askUserQuestionDef,

  // MCP tools - user input
  'mcp__user-input__request_secret': requestSecretDef,
  'mcp__user-input__request_connected_account': requestConnectedAccountDef,
  'mcp__user-input__schedule_task': scheduleTaskDef,
  'mcp__user-input__deliver_file': deliverFileDef,
  'mcp__user-input__request_file': requestFileDef,
  'mcp__user-input__request_remote_mcp': requestRemoteMcpDef,
  'mcp__user-input__request_script_run': requestScriptRunDef,
  'mcp__user-input__request_browser_input': requestBrowserInputDef,

  // MCP tools - browser
  'mcp__browser__browser_open': browserOpenDef,
  'mcp__browser__browser_close': browserCloseDef,
  'mcp__browser__browser_snapshot': browserSnapshotDef,
  'mcp__browser__browser_click': browserClickDef,
  'mcp__browser__browser_fill': browserFillDef,
  'mcp__browser__browser_scroll': browserScrollDef,
  'mcp__browser__browser_wait': browserWaitDef,
  'mcp__browser__browser_press': browserPressDef,
  'mcp__browser__browser_screenshot': browserScreenshotDef,
  'mcp__browser__browser_select': browserSelectDef,
  'mcp__browser__browser_hover': browserHoverDef,
  'mcp__browser__browser_run': browserRunDef,

  // MCP tools - dashboards
  'mcp__dashboards__create_dashboard': createDashboardDef,
  'mcp__dashboards__start_dashboard': startDashboardDef,
  'mcp__dashboards__list_dashboards': listDashboardsDef,
  'mcp__dashboards__get_dashboard_logs': getDashboardLogsDef,
}

export function getToolDefinition(toolName: string): ToolDefinition | undefined {
  return definitions[toolName]
}

export function getRegisteredDefinitionNames(): string[] {
  return Object.keys(definitions)
}
