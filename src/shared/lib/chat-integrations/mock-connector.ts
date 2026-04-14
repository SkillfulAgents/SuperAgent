/**
 * MockChatClientConnector — test double for chat integration testing.
 *
 * Records all sent messages and events for assertion,
 * and provides simulation methods for incoming messages and interactive responses.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { ChatClientConnector, type OutgoingMessage } from './base-connector'

export class MockChatClientConnector extends ChatClientConnector {
  readonly provider = 'telegram' as const // Arbitrary, just needs a valid value

  private connected = false

  // ── Recorded outputs (for assertions) ─────────────────────────────

  sentMessages: { chatId: string; message: OutgoingMessage }[] = []
  sentCards: { chatId: string; event: UserRequestEvent }[] = []
  sentFiles: { chatId: string; filename: string; size: number; caption?: string }[] = []
  streamUpdates: { chatId: string; text: string; existingMessageId?: string }[] = []
  finalizedMessages: { chatId: string; messageId: string; finalText: string }[] = []
  typingIndicators: string[] = []

  private nextMessageId = 1

  // ── Simulation methods ────────────────────────────────────────────

  /** Simulate an incoming message from an external user. */
  simulateIncomingMessage(text: string, chatId = 'mock-chat-1', userId = 'mock-user-1'): void {
    this.emitMessage({
      externalMessageId: `mock-msg-${this.nextMessageId++}`,
      text,
      chatId,
      userId,
      timestamp: new Date(),
    })
  }

  /** Simulate an interactive response (button click / callback query). */
  simulateInteractiveResponse(toolUseId: string, response: unknown): void {
    this.emitInteractiveResponse(toolUseId, response)
  }

  /** Simulate a connection error. */
  simulateError(error: Error): void {
    this.emitError(error)
  }

  // ── Assertion helpers ─────────────────────────────────────────────

  getLastSentMessage(): OutgoingMessage | undefined {
    return this.sentMessages.at(-1)?.message
  }

  getLastSentCard(): UserRequestEvent | undefined {
    return this.sentCards.at(-1)?.event
  }

  getCardsOfType<T extends UserRequestEvent['type']>(type: T): Extract<UserRequestEvent, { type: T }>[] {
    return this.sentCards
      .map((c) => c.event)
      .filter((e): e is Extract<UserRequestEvent, { type: T }> => e.type === type)
  }

  getSentMessageCount(): number {
    return this.sentMessages.length
  }

  reset(): void {
    this.sentMessages = []
    this.sentCards = []
    this.sentFiles = []
    this.streamUpdates = []
    this.finalizedMessages = []
    this.typingIndicators = []
    this.nextMessageId = 1
  }

  // ── ChatClientConnector implementation ────────────────────────────

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const id = `mock-sent-${this.nextMessageId++}`
    this.sentMessages.push({ chatId, message })
    return id
  }

  async sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string> {
    const id = `mock-file-${this.nextMessageId++}`
    this.sentFiles.push({ chatId, filename, size: fileData.length, caption })
    return id
  }

  async sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string> {
    const id = existingMessageId ?? `mock-stream-${this.nextMessageId++}`
    this.streamUpdates.push({ chatId, text, existingMessageId })
    return id
  }

  async finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void> {
    this.finalizedMessages.push({ chatId, messageId, finalText })
  }

  async showTypingIndicator(chatId: string): Promise<void> {
    this.typingIndicators.push(chatId)
  }

  async sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string> {
    const id = `mock-card-${this.nextMessageId++}`
    this.sentCards.push({ chatId, event })
    return id
  }

  isConnected(): boolean {
    return this.connected
  }
}
