import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const callWebHost = vi.hoisted(() => vi.fn())
vi.mock('../web/host-client', () => ({ callWebHost, textResult: vi.fn() }))
import { mediaToolContext } from './index'

afterEach(() => {
  callWebHost.mockReset()
})

it('polls a video job until it is done and saves the mp4', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-wait-'))
  try {
    callWebHost
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'done', video: { mimeType: 'video/mp4', base64: Buffer.from('mp4').toString('base64') } })
    const file = await mediaToolContext('grok', root, 1).waitForVideo('connection:req-1', 10_000)
    expect(callWebHost).toHaveBeenCalledWith('subscription-media', 'grok/video/status', { job: 'connection:req-1' })
    expect(path.extname(file!)).toBe('.mp4')
    expect(await readFile(file!, 'utf8')).toBe('mp4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('stops waiting at the deadline and surfaces failures', async () => {
  callWebHost.mockResolvedValue({ status: 'pending' })
  expect(await mediaToolContext('grok', '/unused', 50).waitForVideo('c:r', 10)).toBeUndefined()
  callWebHost.mockResolvedValueOnce({ status: 'failed', error: 'content policy' })
  await expect(mediaToolContext('grok', '/unused', 1).waitForVideo('c:r', 10)).rejects.toThrow('content policy')
})
