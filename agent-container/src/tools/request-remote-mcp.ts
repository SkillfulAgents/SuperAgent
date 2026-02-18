/**
 * Request Remote MCP Tool - Allows agents to request access to remote MCP servers
 *
 * This tool creates a pending request that blocks until the user provides
 * access to a remote MCP server (potentially going through OAuth) or declines.
 * After approval, the MCP server is dynamically injected into the running query.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { getCurrentProcess } from '../claude-code'
import { sanitizeMcpName } from '../sanitize-mcp-name'

export const requestRemoteMcpTool = tool(
  'request_remote_mcp',
  `Request access to a remote MCP server. The user will be prompted to connect the MCP server (potentially going through OAuth), then assign it to this agent. After approval, the MCP tools become available.

Use this when you need to interact with an MCP server that hasn't been configured for this agent yet. You should know the URL of the MCP server you want to connect to.`,
  {
    url: z
      .url()
      .describe('The URL of the remote MCP server (e.g., https://mcp.example.com/mcp)'),
    name: z
      .string()
      .optional()
      .describe('Suggested display name for the MCP server'),
    reason: z
      .string()
      .optional()
      .describe('Explain why you need access to this MCP server'),
  },
  async (args) => {
    console.log(
      `[request_remote_mcp] Requesting access to MCP server: ${args.url}`
    )

    // Get the toolUseId that was captured by the PreToolUse hook
    const toolUseId = inputManager.consumeCurrentToolUseId()

    if (!toolUseId) {
      console.error(
        '[request_remote_mcp] No toolUseId available - PreToolUse hook may not have fired'
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Unable to process remote MCP request - no tool use ID available.',
          },
        ],
        isError: true,
      }
    }

    console.log(`[request_remote_mcp] Using toolUseId: ${toolUseId}`)

    try {
      // This blocks until the user provides or declines access.
      // The resolve value is the remoteMcpId (UUID).
      const remoteMcpId = await inputManager.createPendingWithType<string>(
        toolUseId,
        'remote_mcp',
        { url: args.url, name: args.name, reason: args.reason }
      )

      // If we get here, the user approved - read updated REMOTE_MCPS
      const remoteMcpsRaw = process.env.REMOTE_MCPS
      let mcpInfo = ''
      if (remoteMcpsRaw) {
        try {
          const mcps = JSON.parse(remoteMcpsRaw) as Array<{
            id: string
            name: string
            proxyUrl: string
            tools: Array<{ name: string }>
          }>
          // Find the approved MCP by ID (from the resolve value)
          const matchingMcp = mcps.find((m) => m.id === remoteMcpId)
          if (matchingMcp) {
            const sanitizedName = sanitizeMcpName(matchingMcp.name)
            const fullToolNames = matchingMcp.tools.map((t) => `mcp__${sanitizedName}__${t.name}`).join(', ')
            mcpInfo = `\n\nMCP Server registered as: ${sanitizedName}\nUse these tools: ${fullToolNames}`

            // Trigger interrupt + restart so the new query picks up the MCP from env var.
            const proc = getCurrentProcess()
            if (proc) {
              proc.addRemoteMcpServer(matchingMcp.name)
            } else {
              console.error('[request_remote_mcp] No active ClaudeCodeProcess found')
            }
          } else {
            console.error(`[request_remote_mcp] MCP id ${remoteMcpId} not found in REMOTE_MCPS env var`)
          }
        } catch (e) {
          console.error('[request_remote_mcp] Failed to parse REMOTE_MCPS env var:', e)
        }
      } else {
        console.error('[request_remote_mcp] REMOTE_MCPS env var not set after approval')
      }

      console.log(`[request_remote_mcp] Access to MCP server granted`)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Access to the remote MCP server has been granted.${mcpInfo}`,
          },
        ],
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      console.log(
        `[request_remote_mcp] Request failed: ${errorMessage}`
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `Remote MCP access request declined: ${errorMessage}. You may need to proceed without this MCP server or ask the user for an alternative approach.`,
          },
        ],
        isError: true,
      }
    }
  }
)
