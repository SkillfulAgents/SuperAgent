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
import { manageScheduledTasksTool } from './tools/manage-scheduled-tasks'
import { deliverFileTool } from './tools/deliver-file'
import { requestFileTool } from './tools/request-file'
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

export function createUserInputMcpServer() {
  return createSdkMcpServer({
    name: 'user-input',
    version: '1.0.0',
    tools: [requestSecretTool, requestConnectedAccountTool, searchConnectedAccountServicesTool, requestRemoteMcpTool, searchRemoteMcpServicesTool, scheduleTaskTool, manageScheduledTasksTool, deliverFileTool, requestFileTool],
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
