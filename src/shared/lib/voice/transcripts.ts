import type { AgentActor } from '../agent-actor/types'
import { transcriptSessionIdSchema, voiceTranscriptAllocationSchema, type VoiceSpeechPiece, type VoiceTranscriptRef } from './transcript-schema'

export function voiceTranscriptDirectory(sessionId: string): string {
  return `/workspace/sessions/${transcriptSessionIdSchema.parse(sessionId)}`
}
export function voiceTranscriptPath(sessionId: string, index: number): string {
  return `${voiceTranscriptDirectory(sessionId)}/transcript-${index}.md`
}
const allocationPath = (sessionId: string, index: number) => `${voiceTranscriptDirectory(sessionId)}/.voice-transcripts/${index}.json`

async function readAllocation(actor: Pick<AgentActor, 'files'>, sessionId: string, index: number) {
  const bytes = await actor.files.getDoc(allocationPath(sessionId, index))
  if (!bytes) return null
  try { return voiceTranscriptAllocationSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) }
  catch (error) { throw new Error('Invalid voice transcript allocation', { cause: error }) }
}

/** Immutable allocations: exclusive file creation arbitrates even across hosts, without a process-local counter. */
export async function startVoiceTranscript(actor: Pick<AgentActor, 'files'>, sessionId: string, id: string): Promise<VoiceTranscriptRef> {
  for (let index = 0; ; index++) {
    let allocation = await readAllocation(actor, sessionId, index)
    if (!allocation) {
      try {
        await actor.files.putDoc(allocationPath(sessionId, index), JSON.stringify(voiceTranscriptAllocationSchema.parse({ id })), { overwrite: false })
        allocation = { id }
      } catch (error) {
        // A competing activation may have taken this index. Other errors still fail startup.
        allocation = await readAllocation(actor, sessionId, index)
        if (!allocation) throw error
      }
    }
    if (allocation.id !== id) continue
    const path = voiceTranscriptPath(sessionId, index)
    await actor.files.append(path, '')
    return { id, index, path }
  }
}

export interface NamedVoiceSpeech extends VoiceSpeechPiece { speaker: string }
/** A batch is already in speech order. Fold whitespace so a speaker cannot manufacture transcript lines. */
export function formatVoiceSpeech(pieces: readonly NamedVoiceSpeech[]): string {
  const lines: Array<{ at: number; lastAt: number; speaker: string; text: string }> = []
  for (const piece of pieces) {
    const line = lines.at(-1)
    if (line && line.speaker === piece.speaker && piece.at - line.lastAt < 2000 && piece.at - line.at < 20_000) {
      line.text += piece.text
      line.lastAt = piece.at
    } else lines.push({ ...piece, lastAt: piece.at })
  }
  const fold = (value: string) => value.replace(/\s+/g, ' ').trim()
  return lines.filter(line => line.text.trim()).map(line =>
    `[${new Date(line.at).toISOString().slice(0, 19).replace('T', ' ')} UTC] ${fold(line.speaker)}: ${fold(line.text)}\n`,
  ).join('')
}

/** Persist before acknowledging: no pending speech is held in a host process or timer. */
export async function appendVoiceTranscript(
  actor: Pick<AgentActor, 'files'>, sessionId: string, index: number, id: string, pieces: readonly NamedVoiceSpeech[],
): Promise<boolean> {
  const allocation = await readAllocation(actor, sessionId, index)
  if (allocation?.id !== id) return false
  await actor.files.append(voiceTranscriptPath(sessionId, index), formatVoiceSpeech(pieces))
  return true
}
