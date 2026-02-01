/**
 * User Input MCP Server
 *
 * This MCP server provides tools for requesting user input during agent execution.
 * Tools in this server will block until the user provides the requested input.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { requestSecretTool } from './tools/request-secret'
import { requestConnectedAccountTool } from './tools/request-connected-account'
import { scheduleTaskTool } from './tools/schedule-task'
import { deliverFileTool } from './tools/deliver-file'
import { requestFileTool } from './tools/request-file'
import { browserTools } from './tools/browser'

/**
 * MCP server for user input tools.
 * Tools will be available as mcp__user-input__<tool_name>
 */
export const userInputMcpServer = createSdkMcpServer({
  name: 'user-input',
  version: '1.0.0',
  tools: [requestSecretTool, requestConnectedAccountTool, scheduleTaskTool, deliverFileTool, requestFileTool],
})

/**
 * MCP server for browser automation tools.
 * Tools will be available as mcp__browser__<tool_name>
 */
export const browserMcpServer = createSdkMcpServer({
  name: 'browser',
  version: '1.0.0',
  tools: browserTools,
})
