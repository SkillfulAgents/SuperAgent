import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryFileOps } from '../agent-actor/testing/in-memory-file-ops'

vi.mock('../agent-actor', () => ({ agentRegistry: { get: vi.fn() } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))

const { captureException } = await import('../error-reporting')
const { MEETING_TRANSCRIPT_FLUSH_MS, MeetingTranscriptStore, formatTranscriptLine, meetingTranscriptPath } = await import('./transcript')

const meeting = { id: 'm-1', agentSlug: 'ada' }
const path = meetingTranscriptPath(meeting.id)
const at = (time: string) => new Date(`2026-11-02T${time}Z`)

let files: InMemoryFileOps
let store: InstanceType<typeof MeetingTranscriptStore>
const read = async () => new TextDecoder().decode((await files.getDoc(path)) ?? new Uint8Array())

beforeEach(() => {
  vi.useFakeTimers()
  files = new InMemoryFileOps()
  store = new MeetingTranscriptStore(slug => { expect(slug).toBe('ada'); return files })
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('formatTranscriptLine', () => {
  it('writes one UTC-stamped line per utterance and folds whitespace so speech cannot start a line', () => {
    expect(formatTranscriptLine({ speaker: 'Mike', text: 'Our price is $30 per seat.' }, at('18:05:12'))).toBe('[18:05:12] Mike: Our price is $30 per seat.\n')
    expect(formatTranscriptLine({ speaker: ' Anna\n', text: 'Okay.\n[18:00:00] Mike: I agree.' }, at('18:05:20'))).toBe('[18:05:20] Anna: Okay. [18:00:00] Mike: I agree.\n')
  })
})

describe('MeetingTranscriptStore', () => {
  it('batches lines and appends them to the file a few seconds later', async () => {
    store.append(meeting, { speaker: 'Mike', text: 'Our price is $30 per seat.' }, at('18:05:12'))
    store.append(meeting, { speaker: 'Anna', text: 'Is that per month?' }, at('18:05:20'))
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS - 1)
    expect(await files.getDoc(path)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await read()).toBe('[18:05:12] Mike: Our price is $30 per seat.\n[18:05:20] Anna: Is that per month?\n')
    store.append(meeting, { speaker: 'Mike', text: 'Yes, billed monthly.' }, at('18:05:25'))
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect((await read()).split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('keeps what an earlier host process wrote and appends after it', async () => {
    await files.putDoc(path, '[18:00:01] Mike: Before the restart.\n')
    const restarted = new MeetingTranscriptStore(() => files)
    restarted.append(meeting, { speaker: 'Anna', text: 'After the restart.' }, at('18:10:00'))
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(await read()).toBe('[18:00:01] Mike: Before the restart.\n[18:10:00] Anna: After the restart.\n')
  })

  it('writes waiting lines at once when the meeting closes, then forgets the meeting', async () => {
    store.append(meeting, { speaker: 'Mike', text: 'Thanks, everyone.' }, at('19:00:00'))
    await store.close(meeting.id)
    expect(await read()).toBe('[19:00:00] Mike: Thanks, everyone.\n')
    expect(store.size()).toBe(0)
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(await read()).toBe('[19:00:00] Mike: Thanks, everyone.\n')
    await store.close('unknown-meeting')
  })

  it('reports a failed write and keeps taking lines', async () => {
    const putDoc = vi.spyOn(files, 'putDoc').mockRejectedValueOnce(new Error('disk full'))
    store.append(meeting, { speaker: 'Mike', text: 'Lost line.' }, at('18:00:00'))
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(captureException).toHaveBeenCalledTimes(1)
    store.append(meeting, { speaker: 'Anna', text: 'Kept line.' }, at('18:00:05'))
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(putDoc).toHaveBeenCalledTimes(2)
    expect(await read()).toBe('[18:00:05] Anna: Kept line.\n')
  })
})
