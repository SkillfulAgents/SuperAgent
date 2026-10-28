import { describe, expect, it } from 'vitest'
import { TurnResponse, assistantTextOf } from './turn-response'

/** A complete assistant frame: one transcript entry of message `id`. */
const frame = (id: string | undefined, uuid: string | undefined, ...content: Array<{ type: string; [key: string]: unknown }>) => ({
  uuid,
  message: { id, content },
})
const text = (value: string) => ({ type: 'text', text: value })
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: {} })

describe('assistantTextOf', () => {
  it('reads a string body as the text', () => {
    expect(assistantTextOf({ message: { content: 'plain' } })).toBe('plain')
  })

  it('joins the text blocks of a block body, skipping the rest', () => {
    expect(assistantTextOf({ message: { content: [text('a'), { type: 'thinking', thinking: 'x' }, toolUse('t1'), text('b')] } })).toBe('ab')
  })

  it('reads nothing from a missing or malformed body', () => {
    expect(assistantTextOf({})).toBe('')
    expect(assistantTextOf({ message: {} })).toBe('')
    expect(assistantTextOf({ message: { content: 42 } })).toBe('')
  })
})

describe('TurnResponse', () => {
  describe('the answer', () => {
    it('is the text of the newest message', () => {
      const response = new TurnResponse()

      expect(response.assistantFrame(frame('msg_1', 'u1', text('Working on it')))).toBe('Working on it')
      response.assistantFrame(frame('msg_2', 'u2', text('All done')))

      expect(response.answer).toBe('All done')
    })

    it('merges frames that share a message id into one message', () => {
      const response = new TurnResponse()

      response.assistantFrame(frame('msg_1', 'u1', text('Part one. ')))
      response.assistantFrame(frame('msg_1', 'u2', toolUse('t1')))
      response.assistantFrame(frame('msg_1', 'u3', text('Part two.')))

      expect(response.answer).toBe('Part one. Part two.')
    })

    it('merges a late frame of an older message into it without making it newest again', () => {
      const response = new TurnResponse()
      response.assistantFrame(frame('msg_1', 'u1', text('Old note')))
      response.assistantFrame(frame('msg_2', 'u2', text('Final answer')))

      const late = response.assistantFrame(frame('msg_1', 'u3', text(' (late)')))

      expect(late).toBe(' (late)')
      expect(response.answer).toBe('Final answer')
    })

    it('counts a replayed frame once, and returns null for the replay', () => {
      const response = new TurnResponse()
      response.assistantFrame(frame('msg_1', 'u1', text('Hello')))

      expect(response.assistantFrame(frame('msg_1', 'u1', text('Hello')))).toBeNull()

      expect(response.answer).toBe('Hello')
    })

    it('ignores a replay of an older frame that arrives after a newer message', () => {
      const response = new TurnResponse()
      response.assistantFrame(frame('msg_1', 'u1', text('Working note')))
      response.assistantFrame(frame('msg_2', 'u2', text('Answer')))

      expect(response.assistantFrame(frame('msg_1', 'u1', text('Working note')))).toBeNull()

      expect(response.answer).toBe('Answer')
    })

    it('lets a newer tool-only message replace the answer, so an earlier working note is never reused', () => {
      const response = new TurnResponse()
      response.assistantFrame(frame('msg_1', 'u1', text('Let me check')))

      expect(response.assistantFrame(frame('msg_2', 'u2', toolUse('t1')))).toBe('')

      expect(response.answer).toBe('')
    })

    it('starts over at a new turn', () => {
      const response = new TurnResponse()
      response.assistantFrame(frame('msg_1', 'u1', text('Previous turn')))

      response.newTurn()

      expect(response.answer).toBe('')
      response.assistantFrame(frame('msg_2', 'u2', text('This turn')))
      expect(response.answer).toBe('This turn')
    })
  })

  describe('queued messages', () => {
    it('leaves the running response as the answer when a queued message is steered into it', () => {
      const response = new TurnResponse()
      response.assistantFrame(frame('msg_1', 'u1', text('First')))
      response.messageQueued()

      response.assistantFrame(frame('msg_1', 'u2', text(' and more')))

      expect(response.answer).toBe('First and more')
    })

    it('starts the queued turn\'s answer at its first output, not at the result before it', () => {
      const response = new TurnResponse()
      response.messageQueued()
      response.assistantFrame(frame('msg_1', 'u1', text('Answer to the first')))

      response.turnCompleted()
      expect(response.answer).toBe('Answer to the first')

      response.assistantFrame(frame('msg_2', 'u2', text('Answer to the queued one')))
      expect(response.answer).toBe('Answer to the queued one')
    })

    it('clears the answer once output of the queued turn arrives', () => {
      const response = new TurnResponse()
      response.messageQueued()
      response.assistantFrame(frame('msg_1', 'u1', text('First')))
      response.turnCompleted()

      response.outputArrived()

      expect(response.answer).toBe('')
    })

    it('does not answer a queued turn that produced no output with the previous turn\'s text', () => {
      const response = new TurnResponse()
      response.messageQueued()
      response.assistantFrame(frame('msg_1', 'u1', text('Answer to the first')))
      response.turnCompleted()

      response.turnCompleted()

      expect(response.answer).toBe('')
    })

    it('takes each queued message as its own turn, in order', () => {
      const response = new TurnResponse()
      response.messageQueued()
      response.messageQueued()

      response.turnCompleted()
      expect(response.queuedTurns).toBe(1)
      expect(response.resetBeforeNextOutput).toBe(true)

      response.assistantFrame(frame('msg_2', 'u2', text('Second')))
      response.turnCompleted()
      expect(response.queuedTurns).toBe(0)
      expect(response.resetBeforeNextOutput).toBe(true)

      response.assistantFrame(frame('msg_3', 'u3', text('Third')))
      response.turnCompleted()
      expect(response.answer).toBe('Third')
      expect(response.resetBeforeNextOutput).toBe(false)
    })

    it('takes back a queued message whose send failed', () => {
      const response = new TurnResponse()
      response.messageQueued()

      response.queuedMessageWithdrawn()
      response.assistantFrame(frame('msg_1', 'u1', text('Answer')))
      response.turnCompleted()

      expect(response.queuedTurns).toBe(0)
      expect(response.resetBeforeNextOutput).toBe(false)
      expect(response.answer).toBe('Answer')
    })

    it('cancels the pending reset when the withdrawn message was the one its turn waited on', () => {
      const response = new TurnResponse()
      response.messageQueued()
      response.assistantFrame(frame('msg_1', 'u1', text('Answer')))
      response.turnCompleted()

      response.queuedMessageWithdrawn()
      response.outputArrived()

      expect(response.resetBeforeNextOutput).toBe(false)
      expect(response.answer).toBe('Answer')
    })

    it('clears the queue at a new turn', () => {
      const response = new TurnResponse()
      response.messageQueued()
      response.turnCompleted()
      response.messageQueued()

      response.newTurn()

      expect(response.queuedTurns).toBe(0)
      expect(response.resetBeforeNextOutput).toBe(false)
    })
  })

  describe('the streamed text', () => {
    it('collects the reply as it streams, starting over with each response', () => {
      const response = new TurnResponse()
      response.beginStreamedText()
      response.appendStreamedText('Hel')
      response.appendStreamedText('lo')
      expect(response.streamedText).toBe('Hello')

      response.beginStreamedText()
      expect(response.streamedText).toBe('')
    })
  })

  describe('the outcome', () => {
    it('answers a completed turn with the answer, falling back on the streamed text', () => {
      const response = new TurnResponse()
      response.appendStreamedText('streamed')
      response.assistantFrame(frame('msg_1', 'u1', text('answer')))

      expect(response.recordOutcome('completed')).toMatchObject({ status: 'completed', responseText: 'answer', error: null })

      const noAnswer = new TurnResponse()
      noAnswer.appendStreamedText('streamed only')
      expect(noAnswer.recordOutcome('completed').responseText).toBe('streamed only')

      expect(new TurnResponse().recordOutcome('completed').responseText).toBe('')
    })

    it('answers a failed or cancelled turn with what streamed, falling back on the answer', () => {
      const response = new TurnResponse()
      response.appendStreamedText('partial reply')
      response.assistantFrame(frame('msg_1', 'u1', text('answer')))
      expect(response.recordOutcome('failed', 'boom').responseText).toBe('partial reply')
      expect(response.recordOutcome('cancelled').responseText).toBe('partial reply')

      const nothingStreamed = new TurnResponse()
      nothingStreamed.assistantFrame(frame('msg_1', 'u1', text('answer')))
      expect(nothingStreamed.recordOutcome('failed', 'boom').responseText).toBe('answer')
    })

    it('carries the error only for a failed turn, with a stand-in when none was given', () => {
      const response = new TurnResponse()

      expect(response.recordOutcome('failed', 'rate limited').error).toBe('rate limited')
      expect(response.recordOutcome('failed').error).toBe('An unknown error occurred')
      expect(response.recordOutcome('cancelled', 'ignored').error).toBeNull()
      expect(response.recordOutcome('completed', 'ignored').error).toBeNull()
    })

    it('keeps the latest outcome, each with its own id', () => {
      const response = new TurnResponse()

      const first = response.recordOutcome('completed')
      const second = response.recordOutcome('cancelled')

      expect(first.id).not.toBe(second.id)
      expect(response.outcome).toBe(second)
    })
  })

  describe('carriedOver', () => {
    it('starts fresh with no prior response', () => {
      const next = TurnResponse.carriedOver(undefined, true)

      expect(next.answer).toBe('')
      expect(next.queuedTurns).toBe(0)
      expect(next.streamedText).toBe('')
      expect(next.outcome).toBeUndefined()
    })

    it('carries the answer and the queue over a reattach mid-turn', () => {
      const prior = new TurnResponse()
      prior.messageQueued()
      prior.assistantFrame(frame('msg_1', 'u1', text('Old note')))
      prior.assistantFrame(frame('msg_2', 'u2', text('Answer')))
      prior.turnCompleted()
      prior.appendStreamedText('streamed')

      const next = TurnResponse.carriedOver(prior, true)

      expect(next.answer).toBe('Answer')
      expect(next.queuedTurns).toBe(0)
      expect(next.resetBeforeNextOutput).toBe(true)
      expect(next.streamedText).toBe('streamed')
    })

    it('carries the message ids and entry uuids mid-turn, so replays and late frames still merge', () => {
      const prior = new TurnResponse()
      prior.assistantFrame(frame('msg_1', 'u1', text('Old note')))
      prior.assistantFrame(frame('msg_2', 'u2', text('Answer')))

      const next = TurnResponse.carriedOver(prior, true)

      expect(next.assistantFrame(frame('msg_2', 'u2', text('Answer')))).toBeNull()
      next.assistantFrame(frame('msg_1', 'u3', text(' late')))
      next.assistantFrame(frame('msg_2', 'u4', text(' continued')))
      expect(next.answer).toBe('Answer continued')
    })

    it('carries only the streamed text and the outcome between turns', () => {
      const prior = new TurnResponse()
      prior.messageQueued()
      prior.assistantFrame(frame('msg_1', 'u1', text('Answer')))
      prior.appendStreamedText('streamed')
      const outcome = prior.recordOutcome('completed')

      const next = TurnResponse.carriedOver(prior, false)

      expect(next.answer).toBe('')
      expect(next.queuedTurns).toBe(0)
      expect(next.resetBeforeNextOutput).toBe(false)
      expect(next.streamedText).toBe('streamed')
      expect(next.outcome).toBe(outcome)
      // Nothing of the old turn's messages: the same id is a new message now.
      expect(next.assistantFrame(frame('msg_1', 'u1', text('Again')))).toBe('Again')
      expect(next.answer).toBe('Again')
    })
  })
})
