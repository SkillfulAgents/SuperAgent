/**
 * Request Secret Tool - Allows agents to request secrets from users
 *
 * This tool creates a pending request that blocks until the user provides
 * or declines to provide the secret. The secret is then made available
 * as an environment variable.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

export const requestSecretTool = tool(
  'request_secret',
  `Request a secret (API key, token, password) from the user. The user will be prompted to provide the value through the UI. Use this when you need credentials that are not already available in your environment.

After the user provides the secret, it will be available as an environment variable with the name you specified.

Example usage:
- secretName: "GITHUB_TOKEN" - User provides value, then $GITHUB_TOKEN is available
- secretName: "OPENAI_API_KEY" - User provides value, then $OPENAI_API_KEY is available

Always check your available environment variables first (listed at the start of the conversation) before requesting a new secret.`,
  {
    secretName: z
      .string()
      .describe(
        'Environment variable name for this secret (e.g., GITHUB_TOKEN, OPENAI_API_KEY). Use UPPER_SNAKE_CASE.'
      ),
    reason: z
      .string()
      .optional()
      .describe(
        'Explain why you need this secret - what you will use it for. This helps the user understand the request.'
      ),
  },
  async (args) => {
    console.log(`[request_secret] Requesting secret ${args.secretName}`)

    // Get the toolUseId that was captured by the PreToolUse hook
    const toolUseId = inputManager.consumeCurrentToolUseId()

    if (!toolUseId) {
      console.error('[request_secret] No toolUseId available - PreToolUse hook may not have fired')
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Unable to process secret request - no tool use ID available.',
          },
        ],
        isError: true,
      }
    }

    console.log(`[request_secret] Using toolUseId: ${toolUseId}`)

    try {
      // This blocks until the user provides or declines the secret
      // The request is keyed by toolUseId (captured via PreToolUse hook)
      // Wait for the user to provide the secret (value is set via /env endpoint)
      await inputManager.createPending(
        toolUseId,
        args.secretName,
        args.reason
      )

      // If we get here, the user provided the secret and it's now in process.env
      // (set by the server before resolving)
      console.log(
        `[request_secret] Secret ${args.secretName} provided successfully`
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `Secret ${args.secretName} has been saved to /workspace/.env. When running Python scripts with uv, use: uv run --env-file .env your_script.py`,
          },
        ],
      }
    } catch (error: unknown) {
      // User declined or request timed out
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      console.log(
        `[request_secret] Secret request for ${args.secretName} failed: ${errorMessage}`
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `Secret request declined: ${errorMessage}. You may need to proceed without this secret or ask the user for an alternative approach.`,
          },
        ],
        isError: true,
      }
    }
  }
)
