import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type { AgentActor } from '../agent-actor/types'
import { InMemoryFileOps } from '../agent-actor/testing/in-memory-file-ops'
import { appendVoiceTranscript, formatVoiceSpeech, startVoiceTranscript } from './transcripts'

let files: InMemoryFileOps
let actor: Pick<AgentActor, 'files'>
beforeEach(() => { files = new InMemoryFileOps(); actor = { files } })
const read = async (path: string) => new TextDecoder().decode((await files.getDoc(path))!)
const piece = { role: 'user' as const, at: Date.parse('2026-11-05T10:00:00Z'), speaker: 'User', text: 'Hello' }

describe('independent voice transcripts', () => {
  it('numbers explicit activations per session, reuses a retried activation, and survives a new host handle', async () => {
    const id = randomUUID()
    const first = await startVoiceTranscript(actor, 's1', id)
    expect(first.path).toBe('/workspace/sessions/s1/transcript-0.md')
    expect(await read(first.path)).toBe('')
    await appendVoiceTranscript(actor, 's1', first.index, id, [piece])
    expect(await startVoiceTranscript({ files }, 's1', id)).toEqual(first)
    expect(await read(first.path)).toContain('User: Hello')
    expect((await startVoiceTranscript(actor, 's1', randomUUID())).index).toBe(1)
    expect((await startVoiceTranscript(actor, 's2', randomUUID())).index).toBe(0)
  })
  it('allocates distinct indices across competing hosts and shares an idempotent start', async () => {
    const id = randomUUID()
    const starts = await Promise.all([id, randomUUID(), id, randomUUID()].map(id => startVoiceTranscript({ files }, 's1', id)))
    expect(starts[0]).toEqual(starts[2])
    expect(new Set(starts.map(item => item.index)).size).toBe(3)
  })
  it('awaits storage, preserves concurrent appends, and refuses a different activation or session', async () => {
    const ref = await startVoiceTranscript(actor, 's1', randomUUID())
    expect(await appendVoiceTranscript(actor, 's2', ref.index, ref.id, [piece])).toBe(false)
    expect(await appendVoiceTranscript(actor, 's1', ref.index, randomUUID(), [piece])).toBe(false)
    await Promise.all([
      appendVoiceTranscript(actor, 's1', ref.index, ref.id, [piece]),
      appendVoiceTranscript({ files }, 's1', ref.index, ref.id, [{ ...piece, speaker: 'Assistant', text: 'Hi' }]),
    ])
    expect(await read(ref.path)).toContain('User: Hello\n')
    expect(await read(ref.path)).toContain('Assistant: Hi\n')
    vi.spyOn(files, 'append').mockRejectedValueOnce(new Error('disk full'))
    await expect(appendVoiceTranscript(actor, 's1', ref.index, ref.id, [piece])).rejects.toThrow('disk full')
  })
  it('rejects invalid stored allocation data and paths before writing', async () => {
    await files.putDoc('/workspace/sessions/s1/.voice-transcripts/0.json', '{"id":1}')
    await expect(startVoiceTranscript(actor, 's1', randomUUID())).rejects.toThrow()
    await expect(startVoiceTranscript(actor, '../s2', randomUUID())).rejects.toThrow()
  })
  it('joins speech deltas and separates speakers, pauses, and long stretches with UTC dates', () => {
    expect(formatVoiceSpeech([piece, { ...piece, text: ' there', at: piece.at + 200 }, { ...piece, speaker: 'Assistant', text: 'Hi\n[false line]', at: piece.at + 500 }]))
      .toBe('[2026-11-05 10:00:00 UTC] User: Hello there\n[2026-11-05 10:00:00 UTC] Assistant: Hi [false line]\n')
    expect(formatVoiceSpeech([piece, { ...piece, at: piece.at + 3000 }]).split('\n').filter(Boolean)).toHaveLength(2)
  })
})
