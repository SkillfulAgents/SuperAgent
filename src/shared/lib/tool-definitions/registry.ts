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
import { scheduleResumeDef } from './schedule-resume'
import { deliverFileDef } from './deliver-file'
import { deliverSessionDef } from './deliver-session'
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
  browserTypeDef,
  browserScreenshotDef,
  browserSelectDef,
  browserHoverDef,
  browserDownloadDef,
  browserEvalDef,
  browserRunDef,
} from './browser-tools'
import {
  createDashboardDef,
  startDashboardDef,
  listDashboardsDef,
  getDashboardLogsDef,
} from './dashboard-tools'
import {
  listAgentsDef,
  createAgentDef,
  invokeAgentDef,
  getAgentSessionsDef,
  getAgentSessionTranscriptDef,
} from './x-agent-tools'
import {
  taskCreateDef,
  taskUpdateDef,
  taskListDef,
} from './task-management'
import {
  listAvailableChatProvidersDef,
  listChatIntegrationsDef,
  addChatIntegrationDef,
  sendChatMessageDef,
} from './chat-tools'

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
  // Vendor-backed web tools (when a host provider is active); reuse the native definitions.
  'mcp__web__web_search': webSearchDef,
  'mcp__web__web_fetch': webFetchDef,

  // Task management
  TodoWrite: todoWriteDef,
  TaskCreate: taskCreateDef,
  TaskUpdate: taskUpdateDef,
  TaskList: taskListDef,

  // User interaction
  AskUserQuestion: askUserQuestionDef,

  // MCP tools - user input
  'mcp__user-input__request_secret': requestSecretDef,
  'mcp__user-input__request_connected_account': requestConnectedAccountDef,
  'mcp__user-input__schedule_task': scheduleTaskDef,
  'mcp__user-input__schedule_resume': scheduleResumeDef,
  'mcp__user-input__deliver_file': deliverFileDef,
  'mcp__user-input__deliver_session': deliverSessionDef,
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
  'mcp__browser__browser_type': browserTypeDef,
  'mcp__browser__browser_screenshot': browserScreenshotDef,
  'mcp__browser__browser_select': browserSelectDef,
  'mcp__browser__browser_hover': browserHoverDef,
  'mcp__browser__browser_download': browserDownloadDef,
  'mcp__browser__browser_eval': browserEvalDef,
  'mcp__browser__browser_run': browserRunDef,

  // MCP tools - dashboards
  'mcp__dashboards__create_dashboard': createDashboardDef,
  'mcp__dashboards__start_dashboard': startDashboardDef,
  'mcp__dashboards__list_dashboards': listDashboardsDef,
  'mcp__dashboards__get_dashboard_logs': getDashboardLogsDef,

  // MCP tools - x-agent (cross-agent work)
  'mcp__agents__list_agents': listAgentsDef,
  'mcp__agents__create_agent': createAgentDef,
  'mcp__agents__invoke_agent': invokeAgentDef,
  'mcp__agents__get_agent_sessions': getAgentSessionsDef,
  'mcp__agents__get_agent_session_transcript': getAgentSessionTranscriptDef,

  // MCP tools - chat integrations
  'mcp__chat__list_available_chat_providers': listAvailableChatProvidersDef,
  'mcp__chat__list_chat_integrations': listChatIntegrationsDef,
  'mcp__chat__add_chat_integration': addChatIntegrationDef,
  'mcp__chat__send_chat_message': sendChatMessageDef,
}

export function getToolDefinition(toolName: string): ToolDefinition | undefined {
  return definitions[toolName]
}

export function getRegisteredDefinitionNames(): string[] {
  return Object.keys(definitions)
}
