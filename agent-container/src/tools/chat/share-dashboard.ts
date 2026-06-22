import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface ShareResult { chatId: string; delivery: 'button' | 'text' }

export const shareDashboardInput = {
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens, not starting/ending with hyphen').describe('Slug of the existing dashboard to share'),
  integration_id: z.string().optional().describe('Chat integration to share through. Optional — defaults to your single active Telegram integration. Use list_chat_integrations to find IDs if you have more than one.'),
  chat_id: z.string().optional().describe('Target chat ID. Optional — defaults to the integration\'s single active chat. Required if there are multiple.'),
}

export async function shareDashboardHandler({ slug, integration_id, chat_id }: { slug: string; integration_id?: string; chat_id?: string }) {
  try {
    const data = await callChatHost<ShareResult>('share-dashboard', { slug, integration_id, chat_id })
    const message = data.delivery === 'button'
      ? `Shared dashboard "${slug}" to chat ${data.chatId}. The user can tap "Open dashboard" to open it inside Telegram.`
      : `Shared dashboard "${slug}" to chat ${data.chatId} as a plain-text message. The user sees the dashboard name but no clickable "Open dashboard" button. Don't point them to a button that isn't there.`
    return textResult(message)
  } catch (error) {
    const msg = error instanceof XAgentError ? error.message : String(error)
    return textResult(`Failed to share dashboard: ${msg}`, true)
  }
}

export const shareDashboardTool = tool(
  'share_dashboard',
  `Surface an existing dashboard to the user in their Telegram chat as a tappable "Open dashboard" button. Tapping it opens the dashboard fully interactively inside Telegram.

Pass the dashboard's slug (see list_dashboards for slugs). The chat is resolved automatically when you have a single active Telegram integration with one active chat; otherwise pass integration_id and/or chat_id (use list_chat_integrations to find them).

Telegram only. If no public web URL is configured, the bot sends a plain text message naming the dashboard instead of a button.`,
  shareDashboardInput,
  shareDashboardHandler,
)
