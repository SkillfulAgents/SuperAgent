/**
 * User Input MCP Server
 *
 * This MCP server provides tools for requesting user input during agent execution.
 * Tools in this server will block until the user provides the requested input.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { requestSecretTool } from './tools/request-secret'

/**
 * MCP server for user input tools.
 * Tools will be available as mcp__user-input__<tool_name>
 */
export const userInputMcpServer = createSdkMcpServer({
  name: 'user-input',
  version: '1.0.0',
  tools: [requestSecretTool],
})
