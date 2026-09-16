import { splitSpeechText } from '@shared/lib/voice/text-chunks'
import { markdownToSpokenWords } from '../../shared/speech/spoken-words'
import { LIVE_TURN_COMPLETE_CUE, legacyLiveRequestSchema, liveRequestSchema, type LiveMappingInput, type LiveRequest, type VoiceHistory, type VoiceTranscriptEntry } from '@shared/lib/voice/live-types'

/** Local delivery metadata, never sent to OpenAI. */
export interface LiveDelivery {
  kind: 'reply' | 'completion'
  isCurrent(): boolean
}

export interface LiveBridgeEvents {
  send: (event: Record<string, unknown>, delivery?: LiveDelivery) => void
  map: (input: LiveMappingInput, signal: AbortSignal) => Promise<unknown>
  onRequest: (request: LiveRequest) => Promise<boolean>
  onUtterance: (text: string) => void
  onInputTranscript?: (delta: string) => void
  onOutputTranscript?: (delta: string) => void
  onTranscript?: (entries: VoiceTranscriptEntry[]) => void
  onError: (message: string) => void
}

/** Each append is limited to 500 tokens. A UTF-8 byte bound also bounds tokens. */
export function liveTextChunks(text: string): string[] {
  return splitSpeechText(text, 400, 'utf8')
}

const LEAK_NGRAM = 6

function wordGrams(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean)
  const grams = new Set<string>()
  for (let i = 0; i + LEAK_NGRAM <= words.length; i++) grams.add(words.slice(i, i + LEAK_NGRAM).join(' '))
  return grams
}

/** True when `text` repeats a run of the voice assistant's words that the user never said. */
export function leaksAssistantSpeech(text: string, assistantSpeech: string, userSpeech: string): boolean {
  const assistant = wordGrams(assistantSpeech)
  if (assistant.size === 0) return false
  const user = wordGrams(userSpeech)
  for (const gram of wordGrams(text)) if (assistant.has(gram) && !user.has(gram)) return true
  return false
}

/** `end`: user characters received up to the end of this entry. Offsets survive trimming and eviction. */
interface BridgeEntry extends VoiceTranscriptEntry { end: number }

/** Live-specific mapping. Neither the session hook nor the agent sees protocol events. */
export class OpenAILiveBridge {
  private transcript: BridgeEntry[] = []
  /** Live subtitle: the user's words since the last mapping. */
  private utterance = ''
  /** User characters received in total, and how many of them the agent has accepted. */
  private receivedUserChars = 0
  private sentUserChars = 0
  private userRevision = 0
  private previousRequest = ''
  private pendingDelegation: string | null = null
  private delegationId: string | null = null
  private seen = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private requestAbort: AbortController | null = null
  private replyAbort: AbortController | null = null
  private replyQueue: Promise<void> = Promise.resolve()
  private replyRevision = 0
  private completionRevision = 0
  private busy = false
  private paused = false
  private closed = false
  private dispatching = false

  constructor(private events: LiveBridgeEvents, private history: VoiceHistory = []) {}

  setBusy(busy: boolean) {
    if (busy && !this.busy) this.cancelCompletion()
    this.busy = busy
  }

  setPaused(paused: boolean) {
    this.paused = paused
    this.requestAbort?.abort()
    clearTimeout(this.timer)
    if (!paused) this.scheduleRequest()
  }

  receive(event: Record<string, unknown>) {
    if (this.closed) return
    // Paused for a request card: the mic is muted, but the reply keeps playing, so its subtitles keep coming.
    if (this.paused && event.type !== 'session.output_transcript.delta') return
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      if (typeof event.delta !== 'string' || !event.delta) return
      const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant'
      if (role === 'user') this.receivedUserChars += event.delta.length
      const last = this.transcript.at(-1)
      // Concatenation is exact; the provider supplies whitespace in its deltas.
      if (last?.role === role) {
        last.text = (last.text + event.delta).slice(-8000)
        last.end = this.receivedUserChars
      } else this.transcript.push({ role, text: event.delta.slice(-8000), end: this.receivedUserChars })
      this.transcript = this.transcript.slice(-24)
      while (this.transcript.length > 1 && this.transcript.reduce((size, item) => size + item.text.length, 0) > 16000) this.transcript.shift()
      // A small immutable tail for rolling subtitles. Keep the full mapping
      // context separate, and never substitute the backend's written reply.
      this.events.onTranscript?.(this.transcript.slice(-6).map(({ role, text }) => ({ role, text: text.slice(-500) })))
      if (role === 'user') {
        this.events.onInputTranscript?.(event.delta)
        this.utterance = (this.utterance + event.delta).slice(-4000)
        this.events.onUtterance(this.utterance)
        this.userRevision++
        this.requestAbort?.abort()
        this.scheduleRequest()
      } else {
        this.events.onOutputTranscript?.(event.delta)
      }
    } else if (event.type === 'session.delegation.created') {
      const delegation = event.delegation as { id?: string; target?: string } | undefined
      if (delegation?.target !== 'client' || !delegation.id || this.seen.has(delegation.id)) return
      this.seen.add(delegation.id)
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!)
      this.pendingDelegation = delegation.id
      this.requestAbort?.abort()
      this.scheduleRequest()
    }
  }

  /** The explicit mic button may request a handoff without waiting for Live. */
  requestNow() {
    if (this.closed || this.paused || !this.unsentUserWords()) return
    if (!this.pendingDelegation) this.pendingDelegation = 'manual'
    this.scheduleRequest(0)
  }

  /** The user's words the agent has not accepted yet, in order, across the voice assistant's turns. */
  private unsentUserWords(): string {
    const parts: string[] = []
    for (const entry of this.transcript) {
      if (entry.role !== 'user') continue
      const start = entry.end - entry.text.length
      const unsent = entry.text.slice(Math.max(0, this.sentUserChars - start)).trim()
      if (unsent) parts.push(unsent)
    }
    return parts.join('\n')
  }

  private assistantSpeech(): string {
    return this.transcript.filter(({ role }) => role === 'assistant').map(({ text }) => text).join('\n')
  }

  private scheduleRequest(delay = 700) {
    clearTimeout(this.timer)
    if (this.closed || this.paused || this.dispatching || !this.pendingDelegation || !this.unsentUserWords()) return
    // This is a coalescing window, not an authoritative end-of-turn detector.
    // Words that turn out incomplete are the backend's to ask about.
    this.timer = setTimeout(() => { void this.resolveRequest() }, delay)
  }

  private async resolveRequest() {
    const id = this.pendingDelegation
    if (!id || this.closed || this.paused) return
    const userWords = this.unsentUserWords()
    if (!userWords) return
    const revision = this.userRevision
    const received = this.receivedUserChars
    const controller = new AbortController()
    this.requestAbort = controller
    let dispatched = false
    try {
      const raw = await this.events.map({
        kind: 'request', history: this.history,
        transcript: this.transcript.map(({ role, text }) => `${role === 'user' ? 'user' : 'voice_assistant'}: ${text}`).join('\n').slice(-16000),
        userWords, previousRequest: this.previousRequest, agentBusy: this.busy,
      }, controller.signal)
      if (controller.signal.aborted || this.closed || this.paused || revision !== this.userRevision || id !== this.pendingDelegation) return
      this.pendingDelegation = null
      this.utterance = ''
      this.events.onUtterance('')
      let request = this.normalize(raw, userWords, id, received)
      if (!request) return
      if (leaksAssistantSpeech(request.text, this.assistantSpeech(), userWords)) {
        console.warn('[voice] Live rewrite repeated the voice assistant\'s words; sending the user\'s own words instead.')
        request = { ...request, text: userWords }
      }
      // Queued words join the running turn, so its replies stay valid.
      if (request.mode !== 'queue' || !this.busy) this.invalidateReplies()
      this.delegationId = id === 'manual' ? null : id
      this.dispatching = true
      dispatched = true
      const accepted = await this.events.onRequest(request)
      if (this.closed) return
      if (accepted) {
        this.sentUserChars = Math.max(this.sentUserChars, received)
        this.previousRequest = request.text
      } else {
        // The words stay unsent: the next delegation or mic press carries them again.
        this.events.onError('The agent could not accept the voice request. Please try again.')
        this.commentary('The request was not accepted by the agent. Ask the user to try again.')
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) {
        this.events.onError(error instanceof Error ? error.message : 'Voice mapping failed.')
        // Keep the request and transcript for an explicit retry, without an automatic retry loop.
      }
    } finally {
      if (dispatched) this.dispatching = false
      if (this.requestAbort === controller) this.requestAbort = null
      if (revision !== this.userRevision) this.scheduleRequest()
    }
  }

  /** A host older than this client still answers with an action; its verdicts map onto the pipe. */
  private normalize(raw: unknown, userWords: string, delegation: string, received: number): LiveRequest | null {
    const current = liveRequestSchema.safeParse(raw)
    if (current.success) return current.data
    const legacy = legacyLiveRequestSchema.parse(raw)
    switch (legacy.action) {
      case 'message': return { text: legacy.text.trim() || userWords, mode: 'interrupt' }
      // The user's own words ("stop") reach the agent; the interrupt path halts the turn.
      case 'cancel': return { text: userWords, mode: 'interrupt' }
      // The words stay unsent, so an answer arrives together with what it answers.
      case 'clarify':
        if (legacy.text.trim()) this.commentary(`Clarification needed: ${legacy.text}`, delegation === 'manual' ? null : delegation)
        return null
      case 'none':
        this.sentUserChars = Math.max(this.sentUserChars, received)
        return null
    }
  }

  invalidateReplies() {
    this.replyRevision++
    this.cancelCompletion()
    this.replyAbort?.abort()
  }

  cancelCompletion() { this.completionRevision++ }

  /** One coherent agent segment, ordered and discarded if a newer request supersedes it. */
  reply(text: string) {
    if (!text.trim()) return
    const revision = this.replyRevision
    const delegation = this.delegationId
    const isCurrent = () => !this.closed && revision === this.replyRevision
    this.replyQueue = this.replyQueue.then(async () => {
      if (!isCurrent()) return
      const controller = new AbortController()
      this.replyAbort = controller
      let content = text
      try {
        if (text.length > 600) {
          const result = await this.events.map({ kind: 'reply', text: text.slice(0, 12000) }, controller.signal) as { text?: string }
          if (!result.text?.trim()) throw new Error('The summarizer returned an empty voice reply.')
          content = result.text
        }
      } catch (error) {
        if (controller.signal.aborted || !isCurrent()) return
        this.events.onError(error instanceof Error ? error.message : 'Could not summarize the reply.')
        // Keep all prose facts, including partial side effects, without feeding
        // display markdown to Live. Chunk only when the transport is ready.
        content = markdownToSpokenWords(text).map(word => word.text).join(' ') ||
          'The backend supplied non-prose output. Its details are available in the application; no outcome can be confirmed from this update.'
      } finally {
        if (this.replyAbort === controller) this.replyAbort = null
      }
      if (!controller.signal.aborted && isCurrent()) this.append('thinking', content, delegation, { kind: 'reply', isCurrent })
    }).catch(error => {
      if (isCurrent()) this.events.onError(error instanceof Error ? error.message : 'Could not deliver the voice update.')
    })
  }

  /** Queue behind every context chunk, including summaries still being mapped. */
  completeReply() {
    const completion = ++this.completionRevision
    const revision = this.replyRevision
    const delegation = this.delegationId
    const isCurrent = () => !this.closed && revision === this.replyRevision && completion === this.completionRevision
    this.replyQueue = this.replyQueue.then(() => {
      if (isCurrent()) this.append('commentary', LIVE_TURN_COMPLETE_CUE, delegation, { kind: 'completion', isCurrent })
    })
  }

  /** Preserve partial work and replace only the success cue, after all context. */
  reportAgentError(message: string) {
    this.cancelCompletion()
    const revision = this.replyRevision
    const delegation = this.delegationId
    const isCurrent = () => !this.closed && revision === this.replyRevision
    this.replyQueue = this.replyQueue.then(() => {
      if (isCurrent()) this.append('commentary', `The agent reported an error: ${message}`, delegation, { kind: 'reply', isCurrent })
    })
  }

  commentary(text: string, delegation = this.delegationId) {
    this.append('commentary', text, delegation)
  }

  /** Standing guidance for the rest of the session, outside any delegation. */
  instructions(text: string) {
    this.append('instructions', text, null)
  }

  private append(type: 'thinking' | 'commentary' | 'instructions', text: string, delegation: string | null, delivery?: LiveDelivery) {
    if (this.closed) return
    this.events.send({ type: `session.${type}.append`, delegation_id: delegation, content: text }, delivery)
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.requestAbort?.abort()
    this.invalidateReplies()
  }
}
