/**
 * What a turn answered, and how it ended.
 *
 * The answer is the text of the newest top-level assistant message group,
 * merged the way the transcript renders it: complete frames that share a
 * message id are one message, a frame for an older id merges into that older
 * message without making it newest again, and a replayed frame (same entry
 * uuid) counts once. A newer id replaces the answer even when it carries no
 * text, so a tool-only final message never reuses an earlier working note.
 *
 * The streamed text is the reply as it streamed, the context an outcome falls
 * back on when the turn fails before its complete message lands.
 */
import { randomUUID } from 'crypto'
import type { SessionTurnOutcome } from '@shared/lib/container/session-turn-outcome-schema'

/** The text of a complete assistant message, from a string or its text blocks. */
export function assistantTextOf(content: { message?: { content?: unknown } }): string {
  const body = content.message?.content
  if (typeof body === 'string') return body
  if (!Array.isArray(body)) return ''
  return body
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')
}

export class TurnResponse {
  /** The completion notification's body: the newest message group's text. */
  answer = ''
  private answerMessageId: string | null = null
  private readonly messageIds = new Set<string>()
  private readonly entryUuids = new Set<string>()
  /**
   * Messages accepted into the running turn that may each become a turn of
   * their own after its result. The answer is reset only when such a turn
   * actually produces output: a message steered into the current response
   * leaves that response the right answer.
   */
  queuedTurns = 0
  resetBeforeNextOutput = false
  /** The reply as it streamed in the current response. */
  streamedText = ''
  /** How the last turn ended, replayed to clients that connect later. */
  outcome: SessionTurnOutcome | undefined = undefined

  /**
   * The response a reattach starts from. Mid-turn the answer and the queued
   * turns carry over; between turns there is nothing to carry. The streamed
   * text and the outcome always do.
   */
  static carriedOver(prior: TurnResponse | undefined, turnInProgress: boolean): TurnResponse {
    const next = new TurnResponse()
    if (!prior) return next
    next.streamedText = prior.streamedText
    next.outcome = prior.outcome
    if (turnInProgress) {
      next.answer = prior.answer
      next.answerMessageId = prior.answerMessageId
      for (const id of prior.messageIds) next.messageIds.add(id)
      for (const uuid of prior.entryUuids) next.entryUuids.add(uuid)
      next.queuedTurns = prior.queuedTurns
      next.resetBeforeNextOutput = prior.resetBeforeNextOutput
    }
    return next
  }

  /** A new turn: no answer yet, nothing queued. */
  newTurn(): void {
    this.clearAnswer()
    this.queuedTurns = 0
    this.resetBeforeNextOutput = false
  }

  /** A message was accepted into the running turn. */
  messageQueued(): void {
    this.queuedTurns += 1
  }

  /** A queued message's send failed: take it back. */
  queuedMessageWithdrawn(): void {
    if (this.queuedTurns > 0) this.queuedTurns -= 1
    else this.resetBeforeNextOutput = false
  }

  /** Output arrived: if a queued message's turn has begun, its answer starts now. */
  outputArrived(): void {
    if (!this.resetBeforeNextOutput) return
    this.clearAnswer()
    this.resetBeforeNextOutput = false
  }

  /**
   * A result that completes a turn (not a pause for resume or a stop): a
   * queued message, if any, is the next turn, and its first output resets
   * the answer.
   */
  turnCompleted(): void {
    this.outputArrived()
    if (this.queuedTurns > 0) {
      this.queuedTurns -= 1
      this.resetBeforeNextOutput = true
    }
  }

  /**
   * A complete top-level assistant frame. Returns its text when the frame is
   * new to this turn, null for a replay of one already counted.
   */
  assistantFrame(content: { uuid?: unknown; message?: { id?: unknown; content?: unknown } }): string | null {
    this.outputArrived()
    const messageId = typeof content.message?.id === 'string' && content.message.id ? content.message.id : null
    const entryUuid = typeof content.uuid === 'string' && content.uuid ? content.uuid : null
    const text = assistantTextOf(content)
    // A resumed CLI can replay persisted frames, even after a newer group.
    if (entryUuid && this.entryUuids.has(entryUuid)) return null
    if (messageId && messageId === this.answerMessageId) {
      this.answer += text
    } else if (messageId && this.messageIds.has(messageId)) {
      // A late frame of an older group (a delayed tool block, typically)
      // merges into that group without making it the newest.
    } else {
      this.answerMessageId = messageId
      this.answer = text
    }
    if (messageId) this.messageIds.add(messageId)
    if (entryUuid) this.entryUuids.add(entryUuid)
    return text
  }

  /** A new response started streaming. */
  beginStreamedText(): void {
    this.streamedText = ''
  }

  appendStreamedText(text: string): void {
    this.streamedText += text
  }

  /** Record how the turn ended. */
  recordOutcome(status: SessionTurnOutcome['status'], error?: string): SessionTurnOutcome {
    this.outcome = {
      id: randomUUID(),
      status,
      responseText: status === 'completed' ? this.answer || this.streamedText || '' : this.streamedText || this.answer,
      error: status === 'failed' ? error ?? 'An unknown error occurred' : null,
    }
    return this.outcome
  }

  private clearAnswer(): void {
    this.answerMessageId = null
    this.answer = ''
  }
}
