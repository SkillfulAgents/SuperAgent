import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryFileOps } from '../agent-actor/testing/in-memory-file-ops'

vi.mock('../agent-actor', () => ({ agentRegistry: { get: vi.fn() } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))

const { MeetingScreenshotStore, SCREENSHOTS_PER_MEETING_MAX, meetingScreenshotsDir, screenshotFileName } = await import('./screenshots')

/** A 320x180 gray screen with white boxes at the given rectangles. */
function screen(...boxes: Array<[x: number, y: number, w: number, h: number]>): Uint8Array {
  const image = new PNG({ width: 320, height: 180 })
  image.data.fill(90)
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
  for (const [bx, by, bw, bh] of boxes) {
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) image.data.fill(255, (y * 320 + x) * 4, (y * 320 + x) * 4 + 3)
  }
  return PNG.sync.write(image)
}

const slide1 = screen([20, 20, 120, 40])
const slide1WithCursor = screen([20, 20, 120, 40], [200, 100, 2, 3])
const slide2 = screen([20, 20, 120, 40], [20, 90, 280, 60])
const meeting = { id: 'm-1', agentSlug: 'helper' }
const settle = () => new Promise(resolve => setImmediate(resolve))

function setup() {
  let clock = 0
  const files = new InMemoryFileOps()
  const store = new MeetingScreenshotStore(() => files, () => clock)
  const saved = () => Object.keys(files.snapshot()).length
  const savedAt = async (name: string) => files.getDoc(`${meetingScreenshotsDir('m-1')}${name}`)
  const offer = async (at: number, png: Uint8Array) => {
    clock = at
    store.offer(meeting, { png, at: new Date(Date.UTC(2026, 10, 4, 10, 20, 0) + at) })
    await settle()
  }
  return { store, saved, savedAt, offer }
}

describe('MeetingScreenshotStore', () => {
  it('saves the first frame, then only frames where the screen visibly changed, at most one per gap', async () => {
    const { saved, savedAt, offer } = setup()
    await offer(0, slide1)
    expect(saved()).toBe(1)
    expect(await savedAt('10-20-00.png')).toEqual(new Uint8Array(slide1))

    await offer(1_000, slide2) // changed, but inside the gap after a save
    await offer(6_000, slide1) // same screen
    await offer(6_500, slide2) // inside the check interval after the last comparison
    await offer(7_000, slide1WithCursor) // a cursor is not a change
    expect(saved()).toBe(1)

    await offer(8_000, slide2)
    expect(saved()).toBe(2)
    expect(await savedAt('10-20-08.png')).toEqual(new Uint8Array(slide2))
  })

  it('stops at the per-meeting limit and forgets a closed meeting', async () => {
    const { store, saved, offer } = setup()
    for (let i = 0; i <= SCREENSHOTS_PER_MEETING_MAX; i++) await offer(i * 6_000, i % 2 === 0 ? slide1 : slide2)
    expect(saved()).toBe(SCREENSHOTS_PER_MEETING_MAX)
    store.close('m-1')
    expect(store.size()).toBe(0)
  })

  it('names files by UTC time of day, matching the transcript clock', () => {
    expect(screenshotFileName(new Date('2026-11-04T19:03:41.392Z'))).toBe('19-03-41.png')
    expect(meetingScreenshotsDir('m-1')).toBe('/workspace/meetings/m-1/screenshots/')
  })
})
