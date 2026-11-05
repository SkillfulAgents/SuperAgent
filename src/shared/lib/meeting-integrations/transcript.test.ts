import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryFileOps } from '../agent-actor/testing/in-memory-file-ops'

vi.mock('../agent-actor', () => ({ agentRegistry: { get: vi.fn() } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))

const { captureException } = await import('../error-reporting')
const { MEETING_TRANSCRIPT_FLUSH_MS, MeetingTranscriptStore, formatTranscriptLine, meetingTranscriptPath } = await import('./transcript')

const meeting = { id: 'm-1', agentSlug: 'ada' }
const path = meetingTranscriptPath(meeting.id)
const T0 = Date.parse('2026-11-04T10:05:10Z')
const at = (ms: number) => T0 + ms

let files: InMemoryFileOps
let store: InstanceType<typeof MeetingTranscriptStore>
const read = async () => new TextDecoder().decode((await files.getDoc(path)) ?? new Uint8Array())
const lines = async () => (await read()).split('\n').filter(Boolean)

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  files = new InMemoryFileOps()
  store = new MeetingTranscriptStore(slug => { expect(slug).toBe('ada'); return files })
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('formatTranscriptLine', () => {
  it('writes one UTC-stamped line and folds whitespace so speech cannot start a line of its own', () => {
    expect(formatTranscriptLine({ speaker: 'Mike', text: ' Our price is $30 per seat.' }, new Date('2026-11-04T18:05:12Z'))).toBe('[18:05:12] Mike: Our price is $30 per seat.\n')
    expect(formatTranscriptLine({ speaker: ' Anna\n', text: 'Okay.\n[18:00:00] Mike: I agree.' }, new Date('2026-11-04T18:05:20Z'))).toBe('[18:05:20] Anna: Okay. [18:00:00] Mike: I agree.\n')
  })
})

describe('MeetingTranscriptStore', () => {
  it('names speech after whoever last started talking and writes each line once it is finished', async () => {
    await store.speakerStarted(meeting, 'Anna', at(0))
    store.append(meeting, { text: 'We ship', at: at(400) })
    store.append(meeting, { text: ' on Friday.', at: at(800) })
    await store.speakerStarted(meeting, 'Bob', at(1500))
    store.append(meeting, { text: 'Great', at: at(1900) })
    store.append(meeting, { text: ', thanks.', at: at(2100) })
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS - 1)
    expect(await files.getDoc(path)).toBeNull()
    // Anna's line ended when Bob started; Bob may still be talking, so his line waits.
    await vi.advanceTimersByTimeAsync(1)
    expect(await lines()).toEqual(['[10:05:10] Anna: We ship on Friday.'])
    // Bob has paused by the next write.
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(await lines()).toEqual(['[10:05:10] Anna: We ship on Friday.', '[10:05:11] Bob: Great, thanks.'])
  })

  it('places speech by when it was heard, even when the change of speaker reaches the host after the words', async () => {
    await store.speakerStarted(meeting, 'Anna', at(0))
    store.append(meeting, { text: 'Can you see my screen?', at: at(1000) })
    store.append(meeting, { text: 'Yes, I can.', at: at(2600) })
    await store.speakerStarted(meeting, 'Bob', at(2400))
    await store.close(meeting.id)
    expect(await lines()).toEqual(['[10:05:11] Anna: Can you see my screen?', '[10:05:12] Bob: Yes, I can.'])
  })

  it("puts the bot's own lines under its name, between the room's", async () => {
    await store.speakerStarted(meeting, 'Anna', at(0))
    store.append(meeting, { text: "What's wrong in this chart?", at: at(500) })
    store.append(meeting, { text: 'The Q3 bar', at: at(2000), speaker: 'Ada (Gamut)' })
    store.append(meeting, { text: ' is missing.', at: at(2300), speaker: 'Ada (Gamut)' })
    store.append(meeting, { text: 'Thanks!', at: at(3500) })
    await store.close(meeting.id)
    expect(await lines()).toEqual([
      "[10:05:10] Anna: What's wrong in this chart?",
      '[10:05:12] Ada (Gamut): The Q3 bar is missing.',
      '[10:05:13] Anna: Thanks!',
    ])
  })

  it('starts a new line after a pause, cuts a long talk into pieces, and leaves speech nobody was reported saying unnamed', async () => {
    store.append(meeting, { text: 'Hello?', at: at(0) })
    await store.speakerStarted(meeting, 'Mike', at(500))
    store.append(meeting, { text: 'First point.', at: at(1000) })
    store.append(meeting, { text: 'Second point.', at: at(3500) })
    // Twelve words 1.9 s apart: no pause, but the line is cut once it is 20 s long.
    for (let k = 0; k < 12; k++) store.append(meeting, { text: ` w${k}`, at: at(30_000 + 1900 * k) })
    await store.close(meeting.id)
    expect(await lines()).toEqual([
      '[10:05:10] Unknown participant: Hello?',
      '[10:05:11] Mike: First point.',
      '[10:05:13] Mike: Second point.',
      '[10:05:40] Mike: w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10',
      '[10:06:00] Mike: w11',
    ])
  })

  it('keeps every line when two host processes write the same meeting, and names speech the same in both', async () => {
    const other = new MeetingTranscriptStore(() => files)
    // The host's callback reached this process; the page's speech reached both.
    await store.speakerStarted(meeting, 'Anna', at(0))
    store.append(meeting, { text: 'From the first process.', at: at(500) })
    other.append(meeting, { text: 'From the second process.', at: at(5000) })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const append = files.append.bind(files)
    vi.spyOn(files, 'append').mockImplementation(async (...args) => { await held; return append(...args) })
    const closing = Promise.all([store.close(meeting.id), other.close(meeting.id)])
    await vi.advanceTimersByTimeAsync(0)
    release()
    await closing
    expect((await lines()).sort()).toEqual(['[10:05:10] Anna: From the first process.', '[10:05:15] Anna: From the second process.'])
  })

  it('keeps what an earlier host process wrote and appends after it', async () => {
    await files.putDoc(path, '[10:00:01] Mike: Before the restart.\n')
    const restarted = new MeetingTranscriptStore(() => files)
    await restarted.speakerStarted(meeting, 'Anna', at(0))
    restarted.append(meeting, { text: 'After the restart.', at: at(500) })
    await restarted.close(meeting.id)
    expect(await read()).toBe('[10:00:01] Mike: Before the restart.\n[10:05:10] Anna: After the restart.\n')
  })

  it('writes everything heard at once when the meeting closes, then forgets the meeting', async () => {
    await store.speakerStarted(meeting, 'Mike', at(0))
    store.append(meeting, { text: 'Thanks, everyone.', at: at(500) })
    await store.close(meeting.id)
    expect(await read()).toBe('[10:05:10] Mike: Thanks, everyone.\n')
    expect(store.size()).toBe(0)
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS * 2)
    expect(await read()).toBe('[10:05:10] Mike: Thanks, everyone.\n')
    await store.close('unknown-meeting')
  })

  it('reports a failed write and keeps taking speech', async () => {
    const append = vi.spyOn(files, 'append').mockRejectedValueOnce(new Error('disk full'))
    await store.speakerStarted(meeting, 'Mike', at(0))
    store.append(meeting, { text: 'Lost line.', at: at(0) })
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(captureException).toHaveBeenCalledTimes(1)
    store.append(meeting, { text: 'Kept line.', at: at(5000) })
    await store.close(meeting.id)
    expect(append).toHaveBeenCalledTimes(2)
    expect(await read()).toBe('[10:05:15] Mike: Kept line.\n')
  })
})
