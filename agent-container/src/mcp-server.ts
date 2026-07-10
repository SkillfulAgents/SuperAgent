/**
 * User Input MCP Server
 *
 * This MCP server provides tools for requesting user input during agent execution.
 * Tools in this server will block until the user provides the requested input.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { webSearchTool } from './tools/web/web-search'
import { webFetchTool } from './tools/web/web-fetch'
import { requestSecretTool } from './tools/request-secret'
import { requestConnectedAccountTool } from './tools/request-connected-account'
import { searchConnectedAccountServicesTool } from './tools/search-connected-account-services'
import { requestRemoteMcpTool } from './tools/request-remote-mcp'
import { searchRemoteMcpServicesTool } from './tools/search-remote-mcp-services'
import {
  scheduleTaskTool,
  listScheduledTasksTool,
  cancelScheduledTaskTool,
  pauseScheduledTaskTool,
  resumeScheduledTaskTool,
} from './tools/schedule-task'
import {
  getAvailableTriggersTool,
  listTriggersTool,
  setupTriggerTool,
  cancelTriggerTool,
  createWebhookEndpointTool,
  updateWebhookEndpointTool,
  inspectWebhookEventsTool,
} from './tools/webhook-triggers'
import { deliverFileTool } from './tools/deliver-file'
import { deliverSessionTool } from './tools/deliver-session'
import { requestFileTool } from './tools/request-file'
import { requestBrowserInputTool } from './tools/request-browser-input'
import { requestScriptRunTool } from './tools/request-script-run'
import { createBrowserTools } from './tools/browser'
import { computerUseTools } from './tools/computer-use'
import { createDashboardTool } from './tools/create-dashboard'
import { startDashboardTool } from './tools/start-dashboard'
import { listDashboardsTool } from './tools/list-dashboards'
import { getDashboardLogsTool } from './tools/get-dashboard-logs'
import { listAgentsTool } from './tools/agents/list-agents'
import { createAgentTool } from './tools/agents/create-agent'
import { makeInvokeAgentTool } from './tools/agents/invoke-agent'
import { getSessionsTool } from './tools/agents/get-sessions'
import { getSessionTranscriptTool } from './tools/agents/get-session-transcript'
import { listAvailableChatProvidersTool } from './tools/chat/list-available-chat-providers'
import { listChatIntegrationsTool } from './tools/chat/list-chat-integrations'
import { addChatIntegrationTool } from './tools/chat/add-chat-integration'
import { sendChatMessageTool } from './tools/chat/send-chat-message'

// TODO: refactor - every MCP should be exported from its own file instead of having one giant factory with conditional logic for which tools to include. This will make it easier to maintain and add new MCPs in the future without modifying existing code.

/**
 * Factory functions for MCP servers.
 * Each query() call needs fresh instances because the MCP protocol only allows
 * one transport connection per server at a time. Reusing singletons across
 * sessions causes "Already connected to a transport" errors.
 */
export function createUserInputMcpServer() {
  // Only expose script execution tool on supported host platforms (macOS/Windows)
  const hostPlatform = process.env.HOST_PLATFORM
  const includeScriptRun = hostPlatform === 'darwin' || hostPlatform === 'win32'

  // Composio-catalog trigger tools need platform Composio; custom webhook
  // endpoints only need platform auth (they live on the platform proxy, so a
  // personal Composio key must not hide them). list/cancel work on local
  // trigger rows and are useful in either mode.
  const includeComposioTriggers = process.env.COMPOSIO_PLATFORM_MODE === 'true'
  const includeWebhookEndpoints = process.env.PLATFORM_AUTH_ACTIVE === 'true'

  return createSdkMcpServer({
    name: 'user-input',
    version: '1.0.0',
    tools: [
      requestSecretTool, requestConnectedAccountTool, searchConnectedAccountServicesTool,
      requestRemoteMcpTool, searchRemoteMcpServicesTool,
      scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool,
      pauseScheduledTaskTool, resumeScheduledTaskTool,
      deliverFileTool, deliverSessionTool, requestFileTool, requestBrowserInputTool,
      ...(includeScriptRun ? [requestScriptRunTool] : []),
      ...(includeComposioTriggers ? [getAvailableTriggersTool, setupTriggerTool] : []),
      ...(includeComposioTriggers || includeWebhookEndpoints
        ? [listTriggersTool, cancelTriggerTool]
        : []),
      ...(includeWebhookEndpoints
        ? [createWebhookEndpointTool, updateWebhookEndpointTool, inspectWebhookEventsTool]
        : []),
    ],
  })
}

/**
 * @param tools - per-session browser tool set from createBrowserTools().
 *   Each session must bind its own tools so browser requests carry that
 *   session's CURRENT id (it changes on query restart) — a shared tool set
 *   races across sessions and strands browser calls on the ownership lock.
 */
export function createBrowserMcpServer(tools: ReturnType<typeof createBrowserTools>) {
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools,
  })
}

export function createComputerUseMcpServer() {
  return createSdkMcpServer({
    name: 'computer-use',
    version: '1.0.0',
    tools: computerUseTools,
  })
}

export function createDashboardsMcpServer() {
  return createSdkMcpServer({
    name: 'dashboards',
    version: '1.0.0',
    tools: [createDashboardTool, startDashboardTool, listDashboardsTool, getDashboardLogsTool],
  })
}

/**
 * @param getCallerSessionId - getter that returns the current Claude session ID
 *   at tool-invocation time. Used by invoke_agent to identify which session is
 *   calling so the host can enforce per-session policies (e.g. preventing an
 *   already-invoked session from invoking further agents).
 */
export function createAgentsMcpServer(getCallerSessionId: () => string) {
  return createSdkMcpServer({
    name: 'agents',
    version: '1.0.0',
    tools: [
      listAgentsTool,
      createAgentTool,
      makeInvokeAgentTool(getCallerSessionId),
      getSessionsTool,
      getSessionTranscriptTool,
    ],
  })
}

export function createChatMcpServer() {
  return createSdkMcpServer({
    name: 'chat',
    version: '1.0.0',
    tools: [
      listAvailableChatProvidersTool,
      listChatIntegrationsTool,
      addChatIntegrationTool,
      sendChatMessageTool,
    ],
  })
}

// Registered when a host-side web search AND/OR fetch vendor is active (server name 'web' → tool
// ids mcp__web__web_search / mcp__web__web_fetch). Each tool is included only when its own vendor is
// active, so a broken tool (one whose host route would 400 "no vendor configured") is never exposed.
// The tools RPC to /api/web-search/search and /api/web-fetch/fetch; the host holds the vendor key
// and applies allowed-sites policy.
export function createWebMcpServer(opts: { search: boolean; fetch: boolean }) {
  const tools = []
  if (opts.search) tools.push(webSearchTool)
  if (opts.fetch) tools.push(webFetchTool)
  return createSdkMcpServer({
    name: 'web',
    version: '1.0.0',
    tools,
  })
}
