import { apiFetch } from '@renderer/lib/api'
import { voiceTranscriptRefSchema, type VoiceSpeechBatch, type VoiceSpeechPiece, type VoiceTranscriptRef } from '@shared/lib/voice/transcript-schema'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'

const FLUSH_MS = 1000
// Leave room under fetch keepalive's 64 KiB budget, including JSON escaping and UTF-8.
const BATCH_BYTES = 24 * 1024

/** One explicit voice activation; engine reconnects reuse it. No provider or meeting knowledge. */
export class VoiceTranscriptRelay {
  private readonly id = crypto.randomUUID()
  private readonly url: string
  private starting: Promise<VoiceTranscriptRef> | null = null
  private pending: VoiceSpeechPiece[] = []
  private batch: VoiceSpeechBatch | null = null
  private transcript: VoiceTranscriptRef | null = null
  private sending: Promise<void> | null = null

  constructor(agentSlug: string, sessionId: string) {
    this.url = `/api/voice/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/transcripts`
  }

  start(): Promise<VoiceTranscriptRef> {
    return this.starting ??= (async () => {
      const response = await apiFetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.id }) })
      if (!response.ok) throw new Error('Could not create the voice transcript.')
      this.transcript = voiceTranscriptRefSchema.parse(await response.json())
      return this.transcript
    })().catch(error => { this.starting = null; throw error })
  }

  append(piece: VoiceTranscriptEntry): void {
    // Providers may deliver either small deltas or whole utterances.
    for (let offset = 0; offset < piece.text.length; offset += 2000) {
      this.pending.push({ at: Date.now(), role: piece.role, text: piece.text.slice(offset, offset + 2000) })
    }
  }

  /** Drain speech received so far before delegating a request or closing the voice conversation. */
  flush(): Promise<void> {
    if (this.sending) return this.sending
    this.sending = (async () => {
      while (this.pending.length || this.batch) await this.send()
    })().finally(() => { this.sending = null })
    return this.sending
  }

  private async send(): Promise<void> {
    const transcript = await this.start()
    this.batch ??= this.takeBatch()
    if (!this.batch) return
    // Keep every request alive: pagehide may happen with a regular batch already in flight.
    const response = await apiFetch(`${this.url}/${transcript.index}/${this.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ ...this.batch, sentAt: Date.now() }),
    })
    if (!response.ok) throw new Error('Could not save the voice transcript.')
    this.batch = null
  }

  private takeBatch(): VoiceSpeechBatch | null {
    const pieces: VoiceSpeechPiece[] = []
    let bytes = 0
    for (const piece of this.pending.slice(0, 500)) {
      const size = new TextEncoder().encode(JSON.stringify(piece)).byteLength + 1
      if (pieces.length && bytes + size > BATCH_BYTES) break
      pieces.push(piece)
      bytes += size
    }
    if (!pieces.length) return null
    this.pending.splice(0, pieces.length)
    return { sentAt: Date.now(), pieces }
  }

  /** Page teardown cannot wait for an earlier response before handing off its tail. */
  private async flushOnExit(): Promise<void> {
    if (!this.transcript) return this.flush()
    if (!this.sending) return this.flush()
    const batch = this.takeBatch()
    if (!batch) return
    try {
      const response = await apiFetch(`${this.url}/${this.transcript.index}/${this.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify(batch),
      })
      if (!response.ok) throw new Error('Could not save the voice transcript.')
    } catch (error) {
      this.pending.unshift(...batch.pieces)
      throw error
    }
  }

  /** Effect attachment, separate from activation identity so StrictMode/reconnects cannot allocate another file. */
  attach(onError: (message: string) => void): () => void {
    const flush = () => { void this.flush().catch(error => onError(error instanceof Error ? error.message : 'Could not save the voice transcript.')) }
    const last = () => { void this.flushOnExit().catch(error => onError(error instanceof Error ? error.message : 'Could not save the voice transcript.')) }
    const timer = setInterval(flush, FLUSH_MS)
    window.addEventListener('pagehide', last)
    return () => { clearInterval(timer); window.removeEventListener('pagehide', last); last() }
  }
}
