/**
 * User Input MCP Server
 *
 * This MCP server provides tools for requesting user input during agent execution.
 * Tools in this server will block until the user provides the requested input.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { requestSecretTool } from './tools/request-secret'
import { requestConnectedAccountTool } from './tools/request-connected-account'
import { searchConnectedAccountServicesTool } from './tools/search-connected-account-services'
import { requestRemoteMcpTool } from './tools/request-remote-mcp'
import { searchRemoteMcpServicesTool } from './tools/search-remote-mcp-services'
import { scheduleTaskTool } from './tools/schedule-task'
import {
  getAvailableTriggersTool,
  listTriggersTool,
  setupTriggerTool,
  cancelTriggerTool,
} from './tools/webhook-triggers'
import { deliverFileTool } from './tools/deliver-file'
import { requestFileTool } from './tools/request-file'
import { requestBrowserInputTool } from './tools/request-browser-input'
import { requestScriptRunTool } from './tools/request-script-run'
import { browserTools } from './tools/browser'
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

  // Webhook trigger tools only available when platform Composio is active
  const includeWebhookTriggers = process.env.COMPOSIO_PLATFORM_MODE === 'true'

  return createSdkMcpServer({
    name: 'user-input',
    version: '1.0.0',
    tools: [
      requestSecretTool, requestConnectedAccountTool, searchConnectedAccountServicesTool,
      requestRemoteMcpTool, searchRemoteMcpServicesTool, scheduleTaskTool,
      deliverFileTool, requestFileTool, requestBrowserInputTool,
      ...(includeScriptRun ? [requestScriptRunTool] : []),
      ...(includeWebhookTriggers ? [getAvailableTriggersTool, listTriggersTool, setupTriggerTool, cancelTriggerTool] : []),
    ],
  })
}

export function createBrowserMcpServer() {
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: browserTools,
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
