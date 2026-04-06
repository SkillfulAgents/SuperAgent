/**
 * Webhook Trigger Tools
 *
 * Tools for managing Composio webhook trigger subscriptions.
 * - get_available_triggers: blocking — returns available trigger types
 * - list_triggers: blocking — returns active triggers for this agent
 * - setup_trigger: blocking — message persister handles dual-write, resolves with result
 * - cancel_trigger: blocking — message persister handles dual-delete, resolves with result
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

export const getAvailableTriggersTool = tool(
  'get_available_triggers',
  `List available webhook triggers for a connected account. Returns trigger types that can fire webhooks (e.g., "new email received", "new GitHub push").

Call this before setup_trigger to discover what triggers are available for a given account.`,
  {
    connected_account_id: z
      .string()
      .describe('The ID of the connected account to list triggers for'),
  },
  async (args) => {
    console.log(`[get_available_triggers] Fetching for account ${args.connected_account_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      // Block until the message persister resolves with trigger data
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'get_available_triggers',
        { connected_account_id: args.connected_account_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to fetch available triggers: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const listTriggersTool = tool(
  'list_triggers',
  `List all active webhook triggers for this agent. Returns trigger IDs, types, connected accounts, and prompts.`,
  {},
  async () => {
    console.log('[list_triggers] Fetching active triggers')

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'list_triggers',
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to list triggers: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const setupTriggerTool = tool(
  'setup_trigger',
  `Set up a webhook trigger on a connected account. When the trigger fires, a new agent session will be created with the specified prompt and the webhook payload.

Use get_available_triggers first to discover what triggers are available for an account.`,
  {
    connected_account_id: z
      .string()
      .describe('The ID of the connected account'),
    trigger_type: z
      .string()
      .describe('The trigger type slug from get_available_triggers (e.g., "GMAIL_NEW_EMAIL")'),
    prompt: z
      .string()
      .describe('What the agent should do when the trigger fires. The webhook payload will be appended automatically.'),
    name: z
      .string()
      .optional()
      .describe('Optional display name for this trigger (e.g., "New email handler")'),
    trigger_config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Optional configuration for the trigger (depends on trigger type)'),
  },
  async (args) => {
    console.log(`[setup_trigger] Setting up ${args.trigger_type} trigger`)

    if (!args.prompt.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Prompt cannot be empty.' }],
        isError: true,
      }
    }

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'setup_trigger',
        {
          connected_account_id: args.connected_account_id,
          trigger_type: args.trigger_type,
          prompt: args.prompt,
          name: args.name,
          trigger_config: args.trigger_config,
        },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to set up trigger: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const cancelTriggerTool = tool(
  'cancel_trigger',
  `Cancel an active webhook trigger by ID. This permanently removes the trigger subscription.`,
  {
    trigger_id: z
      .string()
      .describe('The trigger ID to cancel (from list_triggers)'),
  },
  async (args) => {
    console.log(`[cancel_trigger] Cancelling trigger ${args.trigger_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'cancel_trigger',
        { trigger_id: args.trigger_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to cancel trigger: ${msg}` }],
        isError: true,
      }
    }
  },
)
