import { splitSpeechText } from '@shared/lib/voice/text-chunks'
import { liveRequestSchema, type LiveMappingInput, type LiveRequest, type VoiceHistory, type VoiceTranscriptEntry } from '@shared/lib/voice/live-types'

export interface LiveBridgeEvents {
  send: (event: Record<string, unknown>) => void
  map: (input: LiveMappingInput, signal: AbortSignal) => Promise<unknown>
  onRequest: (request: LiveRequest) => Promise<boolean>
  onUtterance: (text: string) => void
  onInputTranscript?: (delta: string) => void
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
  private busy = false
  private paused = false
  private closed = false
  private dispatching = false

  constructor(private events: LiveBridgeEvents, private history: VoiceHistory = []) {}

  setBusy(busy: boolean) { this.busy = busy }

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
      const mapped = liveRequestSchema.parse(await this.events.map({
        kind: 'request', history: this.history,
        transcript: this.transcript.map(({ role, text }) => `${role === 'user' ? 'user' : 'voice_assistant'}: ${text}`).join('\n').slice(-16000),
        userWords, previousRequest: this.previousRequest, agentBusy: this.busy,
      }, controller.signal))
      if (controller.signal.aborted || this.closed || this.paused || revision !== this.userRevision || id !== this.pendingDelegation) return
      this.pendingDelegation = null
      this.utterance = ''
      this.events.onUtterance('')
      let request: LiveRequest = mapped
      if (leaksAssistantSpeech(mapped.text, this.assistantSpeech(), userWords)) {
        console.warn('[voice] Live rewrite repeated the voice assistant\'s words; sending the user\'s own words instead.')
        request = { ...mapped, text: userWords }
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

  invalidateReplies() {
    this.replyRevision++
    this.replyAbort?.abort()
  }

  /** One coherent agent segment, ordered and discarded if a newer request supersedes it. */
  reply(text: string) {
    if (!text.trim()) return
    const revision = this.replyRevision
    const delegation = this.delegationId
    this.replyQueue = this.replyQueue.then(async () => {
      if (this.closed || revision !== this.replyRevision) return
      const controller = new AbortController()
      this.replyAbort = controller
      try {
        let content = text
        if (text.length > 600) {
          const result = await this.events.map({ kind: 'reply', text: text.slice(0, 12000) }, controller.signal) as { text?: string }
          if (!result.text) throw new Error('The summarizer returned an empty voice reply.')
          content = result.text
        }
        if (!controller.signal.aborted && !this.closed && revision === this.replyRevision) this.commentary(content, delegation)
      } catch (error) {
        if (!controller.signal.aborted && !this.closed) this.events.onError(error instanceof Error ? error.message : 'Could not summarize the reply.')
      } finally {
        if (this.replyAbort === controller) this.replyAbort = null
      }
    })
  }

  commentary(text: string, delegation = this.delegationId) {
    for (const content of liveTextChunks(text)) this.events.send({
      type: 'session.commentary.append', delegation_id: delegation, content, event_id: crypto.randomUUID(),
    })
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.requestAbort?.abort()
    this.invalidateReplies()
  }
}
