/**
 * A conversation the suite drives, with a watermark.
 *
 * Every wait reads strictly forward from the last message the suite has already
 * accounted for. Without that, a check can be satisfied by a *previous* check's
 * output — the failure mode that makes a chat suite quietly stop testing
 * anything — so `since` advances past everything a wait consumed.
 */

import { sendAsSender, messagesSince, currentWatermark, messageText, normalizeSlackText, buttonActionIds, buttonLabels } from './slack.mjs'

export class Conversation {
  constructor({ botToken, sender, channelId, botUserId, log = () => {} }) {
    this.botToken = botToken
    this.sender = sender
    this.channelId = channelId
    this.botUserId = botUserId
    this.log = log
    this.since = '0'
  }

  /** Start reading forward from now, discarding anything already in the channel. */
  async resetWatermark() {
    this.since = await currentWatermark(this.botToken, this.channelId)
    return this.since
  }

  /** Post as the other identity — what a person typing in Slack produces. */
  async say(text) {
    const ts = await sendAsSender(this.sender, this.channelId, text)
    this.log(`→ ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`)
    return ts
  }

  /** Everything posted since the watermark, oldest first (watermark unchanged). */
  async peek() {
    return messagesSince(this.botToken, this.channelId, this.since)
  }

  /**
   * Wait for a message from the integration matching `predicate`.
   *
   * On success the watermark advances past that message, so the next wait
   * cannot re-match it. On timeout the watermark is left alone and everything
   * seen in the window is reported — a timeout here almost always means the
   * agent said something *else*, and that text is the diagnosis.
   */
  async awaitBot(label, predicate, timeoutMs = 180_000, intervalMs = 2_000) {
    const start = Date.now()
    let seen = []
    for (;;) {
      const messages = await this.peek()
      seen = messages
      for (const message of messages) {
        if (message.user !== this.botUserId) continue
        if (predicate(message, messageText(message))) {
          this.since = message.ts
          return message
        }
      }
      if (Date.now() - start > timeoutMs) {
        const transcript = seen
          .map((m) => `    [${m.user === this.botUserId ? 'bot' : 'them'}] ${messageText(m).replace(/\n/g, ' ⏎ ').slice(0, 200)}`)
          .join('\n')
        throw new Error(
          `Timed out after ${Math.round((Date.now() - start) / 1000)}s waiting for ${label}.\n` +
            `  messages in the window:\n${transcript || '    (none)'}`,
        )
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }

  /** Assert the integration posts nothing matching `predicate` within a window. */
  async expectNoBot(label, predicate, windowMs = 15_000) {
    const start = Date.now()
    while (Date.now() - start < windowMs) {
      for (const message of await this.peek()) {
        if (message.user !== this.botUserId) continue
        if (predicate(message, messageText(message))) {
          throw new Error(`Expected no ${label}, but got: ${messageText(message).slice(0, 200)}`)
        }
      }
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }

  /** Advance past everything currently in the window without asserting on it. */
  async drain() {
    const messages = await this.peek()
    if (messages.length > 0) this.since = messages[messages.length - 1].ts
  }
}

export { messageText, normalizeSlackText, buttonActionIds, buttonLabels }
