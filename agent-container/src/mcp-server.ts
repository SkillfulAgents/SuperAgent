/**
 * User Input MCP Server
 *
 * This MCP server provides tools for requesting user input during agent execution.
 * Tools in this server will block until the user provides the requested input.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { requestSecretTool } from './tools/request-secret'
import { requestConnectedAccountTool } from './tools/request-connected-account'
import { requestRemoteMcpTool } from './tools/request-remote-mcp'
import { searchServicesTool } from './tools/search-services'
import { scheduleTaskTool } from './tools/schedule-task'
import { deliverFileTool } from './tools/deliver-file'
import { requestFileTool } from './tools/request-file'
import { requestBrowserInputTool } from './tools/request-browser-input'
import { requestScriptRunTool } from './tools/request-script-run'
import { browserTools } from './tools/browser'
import { createDashboardTool } from './tools/create-dashboard'
import { startDashboardTool } from './tools/start-dashboard'
import { listDashboardsTool } from './tools/list-dashboards'
import { getDashboardLogsTool } from './tools/get-dashboard-logs'

/**
 * Factory functions for MCP servers.
 * Each query() call needs fresh instances because the MCP protocol only allows
 * one transport connection per server at a time. Reusing singletons across
 * sessions causes "Already connected to a transport" errors.
 */
// TODO in the future - create seperate host computer use MCP servers for platform-specific tools (e.g. script execution) instead of conditionally including tools in a single server based on host platform
export function createUserInputMcpServer() {
  // Only expose script execution tool on supported host platforms (macOS/Windows)
  const hostPlatform = process.env.HOST_PLATFORM
  const includeScriptRun = hostPlatform === 'darwin' || hostPlatform === 'win32'

  return createSdkMcpServer({
    name: 'user-input',
    version: '1.0.0',
    tools: [
      requestSecretTool, requestConnectedAccountTool,
      requestRemoteMcpTool, searchServicesTool, scheduleTaskTool,
      deliverFileTool, requestFileTool, requestBrowserInputTool,
      ...(includeScriptRun ? [requestScriptRunTool] : []),
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

export function createDashboardsMcpServer() {
  return createSdkMcpServer({
    name: 'dashboards',
    version: '1.0.0',
    tools: [createDashboardTool, startDashboardTool, listDashboardsTool, getDashboardLogsTool],
  })
}
