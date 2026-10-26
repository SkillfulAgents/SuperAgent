import { describe, expect, it } from 'vitest'
import { switchingFileOps, type WorkspacePhase } from './switching-file-ops'
import { InMemoryFileOps, readAllBytes } from './testing/in-memory-file-ops'

const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)

function setup(initial: WorkspacePhase, settleTimeoutMs = 1_000) {
  const awake = new InMemoryFileOps()
  const asleep = new InMemoryFileOps()
  let phase = initial
  // Each pause is one step of the clock: the phase can change between steps.
  const steps: Array<() => void> = []
  const files = switchingFileOps({
    phase: () => phase,
    awake,
    asleep,
    pause: async () => {
      steps.shift()?.()
    },
    settleTimeoutMs,
  })
  return {
    awake,
    asleep,
    files,
    setPhase: (next: WorkspacePhase) => {
      phase = next
    },
    /** Change the phase after the next pause. */
    thenSettle: (next: WorkspacePhase) => steps.push(() => (phase = next)),
  }
}

describe('switchingFileOps', () => {
  it('reads from the container while it is up and from the store while it is down', async () => {
    const { awake, asleep, files, setPhase } = setup('asleep')
    await awake.putDoc('notes.txt', 'in the container')
    await asleep.putDoc('notes.txt', 'in the store')

    expect(decode(await files.getDoc('notes.txt'))).toBe('in the store')
    setPhase('awake')
    expect(decode(await files.getDoc('notes.txt'))).toBe('in the container')
  })

  it('reads the store while the container is starting or stopping', async () => {
    const { awake, asleep, files } = setup('changing')
    await awake.putDoc('notes.txt', 'half restored')
    await asleep.putDoc('notes.txt', 'as last saved')

    expect(decode(await files.getDoc('notes.txt'))).toBe('as last saved')
    expect((await files.list('')).map((entry) => entry.name)).toEqual(['notes.txt'])
  })

  it('a write while the container is changing waits, then lands where it settled', async () => {
    const { awake, asleep, files, thenSettle } = setup('changing')
    thenSettle('awake')

    await files.putDoc('notes.txt', 'written during the start')

    expect(decode(await awake.getDoc('notes.txt'))).toBe('written during the start')
    expect(await asleep.getDoc('notes.txt')).toBeNull()
  })

  it('a write that the container never lets through fails, and the source is let go', async () => {
    const { awake, asleep, files } = setup('changing', 0)
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull: () => {},
      cancel: () => {
        cancelled = true
      },
    })

    await expect(files.write('upload.bin', body)).rejects.toThrow(/did not settle/)
    expect(cancelled).toBe(true)
    expect(await awake.stat('upload.bin')).toBeNull()
    expect(await asleep.stat('upload.bin')).toBeNull()
  })

  it('an open file stays on the side it was opened on', async () => {
    const { asleep, files, setPhase } = setup('asleep')
    await asleep.putDoc('t.jsonl', '0123')
    const file = await files.open('t.jsonl')
    setPhase('awake')

    expect(await file.size()).toBe(4)
    expect(decode(await readAllBytes(file.stream()))).toBe('0123')
  })
})
