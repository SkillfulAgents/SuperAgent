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

interface AwaitingInputPersister {
  isSessionAwaitingInput(sessionId: string): boolean
  getPendingInputRequests(sessionId: string): Array<{ type: string; toolUseId: string }>
  cancelAwaitingInput(sessionId: string, agentSlug: string): Promise<void>
}

interface DismissibleConnector {
  answerOpenQuestionWithText(chatId: string, toolUseId: string, text: string): Promise<boolean>
  dismissOpenCards(chatId: string): Promise<void>
}

export async function consumeOrCancelAwaitingInput(opts: {
  sessionId: string
  agentSlug: string
  chatId: string
  messageText: string
  hasFiles: boolean
  persister: AwaitingInputPersister
  connector: DismissibleConnector
}): Promise<boolean> {
  const { sessionId, agentSlug, chatId, messageText, hasFiles, persister, connector } = opts

  // A plain-text message during an open single-question card is the free-form "Other" answer:
  // resolve that question so the same turn continues. isSessionAwaitingInput is the source of
  // truth (it reflects taps, cancels, and answers from other surfaces), so we consume the message
  // only on a confirmed live resolve; a non-text message, a multi-question card, or any other
  // awaiting type falls through to cancel.
  const isPlainText = !!messageText.trim() && !hasFiles
  if (isPlainText && persister.isSessionAwaitingInput(sessionId)) {
    const pendingQuestion = persister
      .getPendingInputRequests(sessionId)
      .find((r) => r.type === 'user_question_request')
    if (pendingQuestion) {
      const answered = await connector.answerOpenQuestionWithText(chatId, pendingQuestion.toolUseId, messageText)
      if (answered) return true
    }
  }

  // Not an answer: cancel the pending request so the message starts a fresh turn instead of
  // deadlocking behind the blocked tool (no-op when not awaiting), and strip the now-abandoned
  // card so it does not keep showing live buttons.
  await persister.cancelAwaitingInput(sessionId, agentSlug)
  await connector.dismissOpenCards(chatId)
  return false
}
