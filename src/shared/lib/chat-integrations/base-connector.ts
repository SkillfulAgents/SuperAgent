/**
 * ChatClientConnector — abstract base class for external chat integrations.
 *
 * Each provider (Telegram, Slack, etc.) extends this class and implements
 * the platform-specific connection, messaging, and interactive response logic.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { captureException } from '@shared/lib/error-reporting'

// ── Types ───────────────────────────────────────────────────────────────

export type ChatIntegrationStatus = 'active' | 'paused' | 'error' | 'disconnected'

export interface IncomingMessage {
  externalMessageId: string    // Platform-specific ID (Telegram update_id, Slack message ts)
  text: string
  chatId: string               // Telegram chat_id or Slack channel_id
  userId: string               // Telegram user_id or Slack user_id
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
export type InteractiveResponseHandler = (toolUseId: string, response: unknown) => void
export type ErrorHandler = (error: Error) => void

// ── Abstract class ──────────────────────────────────────────────────────

export abstract class ChatClientConnector {
  abstract readonly provider: 'telegram' | 'slack'

  protected messageHandlers: MessageHandler[] = []
  protected interactiveResponseHandlers: InteractiveResponseHandler[] = []
  protected errorHandlers: ErrorHandler[] = []

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

  /** Show typing / processing indicator. */
  abstract showTypingIndicator(chatId: string): Promise<void>

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

  protected emitInteractiveResponse(toolUseId: string, response: unknown): void {
    for (const handler of this.interactiveResponseHandlers) {
      try {
        handler(toolUseId, response)
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
}
