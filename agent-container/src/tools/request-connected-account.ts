/**
 * Request Connected Account Tool - Allows agents to request access to external services
 *
 * This tool creates a pending request that blocks until the user provides
 * access to connected accounts (via OAuth) or declines.
 * The access tokens are then made available as environment variables.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

export const requestConnectedAccountTool = tool(
  'request_connected_account',
  `Request access to a connected account (e.g., Gmail, Slack, GitHub) from the user. The user will be prompted to select existing connected accounts or connect a new one via OAuth.

After the user provides access, the CONNECTED_ACCOUNTS environment variable will be updated with the new account metadata. You can then make authenticated API calls through the proxy:

URL pattern: $PROXY_BASE_URL/<account_id>/<target_host>/<api_path>
Authorization: Bearer $PROXY_TOKEN

The CONNECTED_ACCOUNTS env var contains JSON mapping toolkit names to arrays of {name, id} objects.

Supported toolkits include:
- gmail - Google email service
- googlecalendar - Google calendar and scheduling
- googledrive - Google cloud storage
- slack - Team communication platform
- github - Code repository and collaboration
- notion - Workspace and documentation
- linear - Issue tracking and project management
- twitter - Social media platform
- discord - Community chat platform
- trello - Project boards and task management

Use this when you need to interact with external services on behalf of the user.`,
  {
    toolkit: z
      .string()
      .describe(
        'The toolkit/service to request access for (e.g., gmail, slack, github). Use lowercase.'
      ),
    reason: z
      .string()
      .optional()
      .describe(
        'Explain why you need access to this service - what you will use it for. This helps the user understand the request.'
      ),
  },
  async (args) => {
    const toolkitLower = args.toolkit.toLowerCase()
    console.log(
      `[request_connected_account] Requesting access to ${toolkitLower}`
    )

    // Get the toolUseId that was captured by the PreToolUse hook
    const toolUseId = inputManager.consumeCurrentToolUseId()

    if (!toolUseId) {
      console.error(
        '[request_connected_account] No toolUseId available - PreToolUse hook may not have fired'
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Unable to process connected account request - no tool use ID available.',
          },
        ],
        isError: true,
      }
    }

    console.log(`[request_connected_account] Using toolUseId: ${toolUseId}`)

    try {
      // This blocks until the user provides or declines access
      // The access tokens are set via /env endpoint before resolving
      await inputManager.createPending(
        toolUseId,
        `CONNECTED_ACCOUNT_${toolkitLower.toUpperCase()}`,
        args.reason
      )

      // If we get here, the user provided access
      console.log(`[request_connected_account] Access to ${toolkitLower} granted`)

      // Read updated account metadata
      const accountsRaw = process.env.CONNECTED_ACCOUNTS
      let accountInfo = ''
      if (accountsRaw) {
        try {
          const parsed = JSON.parse(accountsRaw) as Record<string, Array<{ name: string; id: string }>>
          const toolkitAccounts = parsed[toolkitLower]
          if (toolkitAccounts?.length) {
            accountInfo = `\n\nAvailable ${toolkitLower} accounts:\n${toolkitAccounts.map(a => `- ${a.name} (ID: ${a.id})`).join('\n')}`
          }
        } catch {
          // ignore parse errors
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Access to ${toolkitLower} has been granted. Make API calls through the proxy:\n\nURL: $PROXY_BASE_URL/<account_id>/<target_host>/<api_path>\nAuthorization: Bearer $PROXY_TOKEN${accountInfo}`,
          },
        ],
      }
    } catch (error: unknown) {
      // User declined or request timed out
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      console.log(
        `[request_connected_account] Request for ${toolkitLower} failed: ${errorMessage}`
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `Access request declined: ${errorMessage}. You may need to proceed without ${toolkitLower} access or ask the user for an alternative approach.`,
          },
        ],
        isError: true,
      }
    }
  }
)
