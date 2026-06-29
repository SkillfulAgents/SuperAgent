/**
 * ChatClientConnector — abstract base class for external chat integrations.
 *
 * Each provider (Telegram, Slack, etc.) extends this class and implements
 * the platform-specific connection, messaging, and interactive response logic.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { SessionActivity } from '@shared/lib/types/agent'
import type { ChatProvider } from './config-schema'
import { captureException } from '@shared/lib/error-reporting'

// ── Types ───────────────────────────────────────────────────────────────

export type ChatIntegrationStatus = 'active' | 'paused' | 'error' | 'disconnected'

export interface IncomingMessage {
  externalMessageId: string    // Platform-specific ID (Telegram update_id, Slack message ts)
  text: string
  chatId: string               // Telegram chat_id or Slack channel_id
  userId: string               // Telegram user_id or Slack user_id
  chatType?: 'private' | 'group' | 'supergroup'  // Telegram chat type (undefined for non-Telegram connectors)
  userName?: string            // Display name of the user (for session naming)
  chatName?: string            // Display name of the chat/channel (for session naming)
  files?: { name: string; url: string; mimeType?: string }[]
  timestamp: Date
}

export interface OutgoingMessage {
  text: string
  parseMode?: 'html' | 'markdown'
  replyToExternalId?: string
}

export type MessageHandler = (message: IncomingMessage) => void
export type InteractiveResponseHandler = (toolUseId: string, response: unknown, chatId?: string) => void
export type ErrorHandler = (error: Error) => void
export type TypingHintHandler = (chatId: string) => void

// ── Abstract class ──────────────────────────────────────────────────────

export abstract class ChatClientConnector {
  abstract readonly provider: ChatProvider

  protected messageHandlers: MessageHandler[] = []
  protected interactiveResponseHandlers: InteractiveResponseHandler[] = []
  protected errorHandlers: ErrorHandler[] = []
  protected typingHintHandlers: TypingHintHandler[] = []

  /** Establish connection (long-poll loop / WebSocket). Resolves once healthy. */
  abstract connect(): Promise<void>

  /** Tear down connection gracefully. */
  abstract disconnect(): Promise<void>

  /** Send a text message (final, complete). Returns external message ID. */
  abstract sendMessage(chatId: string, message: OutgoingMessage): Promise<string>

  /**
   * Streaming: send or update a "draft" message with partial content.
   * First call (no existingMessageId) creates the message.
   * Subsequent calls edit the existing message.
   * Returns the external message ID.
   */
  abstract sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string>

  /** Finalize a streaming message (last edit with final text). */
  abstract finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void>

  /**
   * Signal that the agent is busy, labeled by what it is doing (`activity`). The
   * connector owns how that maps to its surface (Telegram labels a draft, Slack
   * reacts) AND any keep-alive needed to survive provider-side expiry. Called
   * again with a new activity when the label changes mid-turn. Idempotent — safe
   * to call repeatedly for the same chat.
   */
  abstract startWorking(chatId: string, activity: SessionActivity): Promise<void>

  /**
   * Stop the working indicator as the response takes over. Idempotent — safe to
   * call repeatedly. Default no-op for connectors whose indicator is ephemeral
   * and self-expires.
   */
  async stopWorking(_chatId: string): Promise<void> {}

  /**
   * Send a file to the chat. Returns the external message ID.
   * @param chatId Target chat/channel
   * @param fileData Buffer of the file content
   * @param filename Display name for the file
   * @param caption Optional text caption to accompany the file
   */
  abstract sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string>

  /**
   * Send a rich card for user-request items.
   * Each connector pattern-matches on event.type and renders natively
   * (Slack Block Kit, Telegram inline keyboards, etc.).
   * Returns the external message ID.
   */
  abstract sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string>

  /**
   * Resolve an open single-question AskUserQuestion card with a free-typed message as the
   * "Other" answer. Returns true only if a live card matching `toolUseId` is open for this chat,
   * so the manager consumes the message only on a real resolve. Default: not supported (false).
   */
  async answerOpenQuestionWithText(_chatId: string, _toolUseId: string, _text: string): Promise<boolean> {
    return false
  }

  /**
   * Dismiss every open request card for this chat: strip its inline keyboard and forget its
   * callbacks, so a card abandoned by a cancelling message doesn't keep showing live buttons.
   * Called on the cancel path when a new message starts a fresh turn. Default no-op for
   * connectors without interactive cards.
   */
  async dismissOpenCards(_chatId: string): Promise<void> {}

  /** Whether the connection is healthy right now. */
  abstract isConnected(): boolean

  // ── Event subscription ──────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler)
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler)
    }
  }

  onInteractiveResponse(handler: InteractiveResponseHandler): () => void {
    this.interactiveResponseHandlers.push(handler)
    return () => {
      this.interactiveResponseHandlers = this.interactiveResponseHandlers.filter((h) => h !== handler)
    }
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.push(handler)
    return () => {
      this.errorHandlers = this.errorHandlers.filter((h) => h !== handler)
    }
  }

  /** Subscribe to typing hints (e.g. external user started typing). Useful for pre-warming containers. */
  onTypingHint(handler: TypingHintHandler): () => void {
    this.typingHintHandlers.push(handler)
    return () => {
      this.typingHintHandlers = this.typingHintHandlers.filter((h) => h !== handler)
    }
  }

  // ── Protected helpers for subclasses ────────────────────────────────

  protected emitMessage(message: IncomingMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message)
      } catch (err) {
        console.error('[ChatConnector] Error in message handler:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'emit-message' }, extra: { provider: this.provider, chatId: message.chatId } })
      }
    }
  }

  protected emitInteractiveResponse(toolUseId: string, response: unknown, chatId?: string): void {
    for (const handler of this.interactiveResponseHandlers) {
      try {
        handler(toolUseId, response, chatId)
      } catch (err) {
        console.error('[ChatConnector] Error in interactive response handler:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'emit-interactive-response' }, extra: { provider: this.provider, toolUseId } })
      }
    }
  }

  protected emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error)
      } catch (err) {
        console.error('[ChatConnector] Error in error handler:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'emit-error' }, extra: { provider: this.provider, originalError: error.message } })
      }
    }
  }

  protected emitTypingHint(chatId: string): void {
    for (const handler of this.typingHintHandlers) {
      try {
        handler(chatId)
      } catch {
        // Non-critical — best-effort pre-warm
      }
    }
  }
}
