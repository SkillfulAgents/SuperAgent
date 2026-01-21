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

After the user provides access, the account credentials will be available as an environment variable named CONNECTED_ACCOUNT_<TOOLKIT> (e.g., CONNECTED_ACCOUNT_GMAIL).

The environment variable value is a JSON object mapping account display names to access tokens:
{"Work Gmail": "ya29.xxx...", "Personal Gmail": "ya29.yyy..."}

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
      const envVarName = `CONNECTED_ACCOUNT_${toolkitLower.toUpperCase()}`
      console.log(`[request_connected_account] Access to ${toolkitLower} granted`)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Access to ${toolkitLower} has been granted. The access tokens are available in the environment variable ${envVarName}. Parse the JSON value to get the account display names and their tokens.`,
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
