/**
 * On an inbound chat message while a session may be awaiting user input, decide whether the
 * message answers an open question or cancels the pending request.
 *
 * If it is a plain-text reply (no attachments) and a single-question AskUserQuestion card is open,
 * resolve that question as the free-form "Other" answer so the same turn continues. Otherwise
 * cancel the pending request and dismiss its now-abandoned card, so the caller forwards the
 * message as a fresh turn. Returns true when the message was consumed as an answer (the caller
 * should stop), false when the caller should forward it.
 *
 * Extracted from the manager's inbound handler so the answer-vs-cancel decision (and the
 * dismiss-on-cancel wiring) is unit-testable without the full container/session harness.
 */

/** The chat's session, through its agent's actor, narrowed to what this decision needs. */
interface AwaitingSession {
  /**
   * Whether the session waits on the user (the source of truth for every
   * surface), and its open requests, from the registry the app answers from too.
   */
  live(): Promise<{ isAwaitingInput: boolean; openRequests: Array<{ id: string; kind: string; payload: unknown }> }>
  /** Cancel what the session waits on (a no-op when it waits on nothing). */
  cancelAwaiting(): Promise<void>
}

interface DismissibleConnector {
  answerOpenQuestionWithText(chatId: string, toolUseId: string, text: string): Promise<boolean>
  dismissOpenCards(chatId: string): Promise<void>
}

export async function consumeOrCancelAwaitingInput(opts: {
  chatId: string
  messageText: string
  // The raw user text to resolve an open question with as the "Other" answer. Distinct from
  // messageText, which may carry a group sender-name prefix (e.g. `\[Alice]: `) meant only for the
  // fresh-turn forward path — that prefix must not leak into the answer sent to the model. Falls
  // back to messageText when not supplied.
  answerText?: string
  hasFiles: boolean
  session: AwaitingSession
  connector: DismissibleConnector
}): Promise<boolean> {
  const { chatId, messageText, answerText, hasFiles, session, connector } = opts

  // A plain-text message during an open single-question card is the free-form "Other" answer:
  // resolve that question so the same turn continues. isAwaitingInput is the source of
  // truth (it reflects taps, cancels, and answers from other surfaces), so we consume the message
  // only on a confirmed live resolve; a non-text message, a multi-question card, or any other
  // awaiting type falls through to cancel.
  const isPlainText = !!messageText.trim() && !hasFiles
  const live = isPlainText ? await session.live() : null
  if (live?.isAwaitingInput) {
    // Recovered stubs are excluded the same way they are excluded from the
    // wire: they carry no renderable payload, so no card was ever posted and
    // there is nothing in this chat for the text to answer.
    const pendingQuestion = live.openRequests
      .find((r) => r.kind === 'question' && (r.payload as { recovered?: unknown }).recovered !== true)
    if (pendingQuestion) {
      const answered = await connector.answerOpenQuestionWithText(chatId, pendingQuestion.id, answerText ?? messageText)
      if (answered) return true
    }
  }

  // Not an answer: cancel the pending request so the message starts a fresh turn instead of
  // deadlocking behind the blocked tool (no-op when not awaiting), and strip the now-abandoned
  // card so it does not keep showing live buttons.
  await session.cancelAwaiting()
  await connector.dismissOpenCards(chatId)
  return false
}
