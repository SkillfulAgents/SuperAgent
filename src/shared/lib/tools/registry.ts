/**
 * Tool definition registry.
 *
 * Maps tool names to their definitions. Usable from both backend
 * (MessagePersister, AgentIntegrationManager) and renderer.
 */

import type { RequestDefinition } from './requests/definition'
import type { UserInputRequestKind } from './requests/request-schema'
import { computerUseRequestDef } from './computer-use/definition'
import { capabilityReviewRequestDef } from './capability-review/definition'
import { proxyReviewRequestDef } from './proxy-review/definition'
import { xAgentReviewRequestDef } from './x-agent-review/definition'
import { accountReauthRequestDef } from './account-reauth/definition'
import { mcpReauthRequestDef } from './mcp-reauth/definition'
import type { ToolDefinition } from './types'
import { bashDef } from './bash/definition'
import { readDef } from './read/definition'
import { writeDef } from './write/definition'
import { globDef } from './glob/definition'
import { grepDef } from './grep/definition'
import { webSearchDef } from './web-search/definition'
import { webFetchDef } from './web-fetch/definition'
import { todoWriteDef } from './todo-write/definition'
import { taskDef } from './task/definition'
import { askUserQuestionDef } from './ask-user-question/definition'
import { requestSecretDef } from './request-secret/definition'
import { requestConnectedAccountDef } from './request-connected-account/definition'
import { scheduleTaskDef } from './schedule-task/definition'
import { scheduleResumeDef } from './schedule-resume/definition'
import { deliverFileDef } from './deliver-file/definition'
import { deliverSessionDef } from './deliver-session/definition'
import { requestFileDef } from './request-file/definition'
import { requestRemoteMcpDef } from './request-remote-mcp/definition'
import { requestScriptRunDef } from './request-script-run/definition'
import { requestBrowserInputDef } from './request-browser-input/definition'
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
} from './browser-tools/definition'
import {
  createDashboardDef,
  startDashboardDef,
  listDashboardsDef,
  getDashboardLogsDef,
} from './dashboard-tools/definition'
import {
  listAgentsDef,
  createAgentDef,
  invokeAgentDef,
  getAgentSessionsDef,
  getAgentSessionTranscriptDef,
  downloadAgentFileDef,
} from './x-agent-tools/definition'
import {
  taskCreateDef,
  taskUpdateDef,
  taskListDef,
} from './task-management/definition'
import {
  listAvailableChatProvidersDef,
  listAgentIntegrationsDef,
  addChatIntegrationDef,
  sendChatMessageDef,
} from './chat-tools/definition'

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
  'mcp__agents__download_agent_file': downloadAgentFileDef,

  // MCP tools - chat integrations
  'mcp__chat__list_available_chat_providers': listAvailableChatProvidersDef,
  'mcp__chat__list_agent_integrations': listAgentIntegrationsDef,
  // Historical transcripts retain the original tool name.
  'mcp__chat__list_chat_integrations': listAgentIntegrationsDef,
  'mcp__chat__add_chat_integration': addChatIntegrationDef,
  'mcp__chat__send_chat_message': sendChatMessageDef,
}

export function getToolDefinition(toolName: string): ToolDefinition | undefined {
  return definitions[toolName]
}

export function getRegisteredDefinitionNames(): string[] {
  return Object.keys(definitions)
}

export function getToolPresentation(toolName: string) {
  const definition = getToolDefinition(toolName)
  return {
    hideToolStatusInChat: definition?.hideToolStatusInChat === true,
    // Older and generic user-input tools have no custom definition. Keep their
    // existing transcript label; this fallback does not create blocking waits.
    showWaitingForInput: definition?.showWaitingForInput ?? toolName.startsWith('mcp__user-input__'),
  }
}

/** Tool aliases share the same request object; standalone requests register here too. */
const requestDefinitions = new Map<UserInputRequestKind, RequestDefinition>()
for (const request of [
  ...new Set(Object.values(definitions).flatMap(definition => definition.request ? [definition.request] : [])),
  computerUseRequestDef,
  capabilityReviewRequestDef,
  proxyReviewRequestDef,
  xAgentReviewRequestDef,
  accountReauthRequestDef,
  mcpReauthRequestDef,
]) {
  if (requestDefinitions.has(request.kind)) throw new Error(`Duplicate request definition: ${request.kind}`)
  requestDefinitions.set(request.kind, request)
}

export function getRequestDefinition<K extends UserInputRequestKind>(kind: K): RequestDefinition<K> {
  const definition = requestDefinitions.get(kind)
  if (!definition) throw new Error(`Missing request definition: ${kind}`)
  // Entries are indexed by their own discriminant above.
  return definition as RequestDefinition<K>
}
