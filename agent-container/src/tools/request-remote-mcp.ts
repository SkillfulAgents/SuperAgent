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
import { sanitizeMcpName } from '../sanitize-mcp-name'

/**
 * The one capability this tool needs from the process that owns the query it
 * is running inside. Structural rather than the ClaudeCodeProcess type so the
 * tool module doesn't import back into claude-code.ts.
 */
export interface RemoteMcpInjectionTarget {
  addRemoteMcpServer(name: string): void
}

/**
 * Bound to its OWNING process, not to a module global. The container can hold
 * processes that are not the caller — other live sessions, and the pre-warmed
 * one parked for the next session — and injecting the approved MCP into any of
 * them would leave the session that asked for it without the tools, because
 * only the owning query restarts.
 */
export function createRequestRemoteMcpTool(getProcess: () => RemoteMcpInjectionTarget | null) {
  return tool(
  'request_remote_mcp',
  `Request access to a remote MCP server. The user will be prompted to connect the MCP server (potentially going through OAuth), then assign it to this agent. After approval, the MCP tools become available.

Use this when you need to interact with an MCP server that hasn't been configured for this agent yet. You should know the URL of the MCP server you want to connect to.

Some servers cannot be connected by approving this request alone: the user must first register an OAuth app in the provider's own console and allowlist our callback URL. search_remote_mcp_services flags those servers. When one is flagged, say so before calling this tool, so the user knows the approval prompt will ask them for setup they have to do outside this session. The prompt itself shows them the exact steps and callback URL.

Never ask the user to paste a client secret into the chat. If they want you to look up a client_id in their provider console, do that with the browser tools and pass it as clientId — they can still edit it before connecting.`,
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
      .describe("A question for the user following the pattern 'Allow access to {server} to {purpose}?'. Never use first person. Must end with '?'. Example: 'Allow access to Slack MCP to post the weekly summary?'"),
    authHint: z
      .enum(['oauth', 'bearer'])
      .optional()
      .describe('Authentication type hint if known (e.g., from reading the MCP server docs). Use "oauth" for servers requiring OAuth authorization, "bearer" for servers requiring a bearer token.'),
    clientId: z
      .string()
      .optional()
      .describe('OAuth client_id to prefill, for servers that reject dynamic client registration and require an app the user registered themselves. Only pass a value the user gave you or that you read from their provider console at their request — never invent one. The user can edit it before connecting.'),
    clientName: z
      .string()
      .optional()
      .describe('Override the client_name sent during dynamic client registration. Rarely needed.'),
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
      // The resolve value is one or more remoteMcpIds (UUIDs).
      const resolvedRemoteMcpIds = await inputManager.createPendingWithType<string | string[]>(
        toolUseId,
        'remote_mcp',
        {
          url: args.url,
          name: args.name,
          reason: args.reason,
          authHint: args.authHint,
          clientId: args.clientId,
          clientName: args.clientName,
        }
      )
      const remoteMcpIds = Array.isArray(resolvedRemoteMcpIds) ? resolvedRemoteMcpIds : [resolvedRemoteMcpIds]

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
          const matchingMcps = mcps.filter((m) => remoteMcpIds.includes(m.id))
          if (matchingMcps.length > 0) {
            const mcpBlocks = matchingMcps.map((matchingMcp) => {
              const sanitizedName = sanitizeMcpName(matchingMcp.name)
              const fullToolNames = matchingMcp.tools.map((t) => `mcp__${sanitizedName}__${t.name}`).join(', ')
              return `MCP Server registered as: ${sanitizedName}\nUse these tools: ${fullToolNames}`
            })
            mcpInfo = `\n\n${mcpBlocks.join('\n\n')}`

            // Trigger interrupt + restart so the new query picks up the MCP from env var.
            const proc = getProcess()
            if (proc) {
              matchingMcps.forEach((matchingMcp) => proc.addRemoteMcpServer(matchingMcp.name))
            } else {
              console.error('[request_remote_mcp] No active ClaudeCodeProcess found')
            }
          } else {
            console.error(`[request_remote_mcp] MCP ids ${remoteMcpIds.join(', ')} not found in REMOTE_MCPS env var`)
          }
        } catch (e) {
          console.error('[request_remote_mcp] Failed to parse REMOTE_MCPS env var:', e)
        }
      } else {
        console.error('[request_remote_mcp] REMOTE_MCPS env var not set after approval')
      }

      console.log(`[request_remote_mcp] Access to MCP server granted`)

      // Approval resolved but the server never made it into REMOTE_MCPS (e.g.
      // it is not active and was filtered out). Without this warning the model
      // is told "granted" and then hunts for tools that will never register.
      if (!mcpInfo) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The remote MCP request was approved, but the server is not active in this session and its tools were NOT registered. The server most likely needs to be re-authenticated. Tell the user the MCP connection needs to be reconnected (via its connection settings) before its tools can be used — do not assume the tools are available.',
            },
          ],
          isError: true,
        }
      }

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
}
