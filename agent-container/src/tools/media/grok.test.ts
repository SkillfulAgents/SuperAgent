import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { grokMediaTools } from './grok'
import { mediaToolProviders } from './index'

const generateImages = vi.fn(async () => ['/workspace/media/grok-1.jpg'])
const startVideo = vi.fn(async () => 'connection:request-1')
const waitForVideo = vi.fn<(job: string, timeoutMs: number) => Promise<string | undefined>>()
const [grokTool, videoTool, getVideoTool] = grokMediaTools({ generateImages, startVideo, waitForVideo })

afterEach(() => {
  vi.clearAllMocks()
})

it('is registered as a provider-prefixed tool', () => {
  expect([grokTool.name, videoTool.name, getVideoTool.name]).toEqual(['grok_generate_image', 'grok_generate_video', 'grok_get_video'])
  expect(mediaToolProviders(['codex', 'grok'])).toEqual(['codex', 'grok'])
})

it('maps tool arguments to the host request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-media-'))
  try {
    const source = path.join(root, 'photo.jpg')
    await writeFile(source, 'foo')
    const result = await grokTool.handler({ prompt: 'as a sketch', aspect_ratio: '1:1', resolution: '2k', referenced_image_paths: [source] }, {})
    expect(generateImages).toHaveBeenCalledWith({ prompt: 'as a sketch', aspectRatio: '1:1', resolution: '2k', images: ['data:image/jpeg;base64,Zm9v'] })
    expect(result.content).toEqual([{ type: 'text', text: 'Generated with Grok:\n/workspace/media/grok-1.jpg' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('starts a video and returns the saved file when it finishes in time', async () => {
  waitForVideo.mockResolvedValueOnce('/workspace/media/grok-1.mp4')
  const result = await videoTool.handler({ prompt: 'waves', duration: 6, resolution: '720p' }, {})
  expect(startVideo).toHaveBeenCalledWith({ prompt: 'waves', image: undefined, duration: 6, aspectRatio: undefined, resolution: '720p' })
  expect(result.content).toEqual([{ type: 'text', text: 'Generated with Grok:\n/workspace/media/grok-1.mp4' }])
})

it('hands back the job id while the video is still rendering', async () => {
  waitForVideo.mockResolvedValueOnce(undefined).mockResolvedValueOnce('/workspace/media/grok-1.mp4')
  const pending = await videoTool.handler({ prompt: 'waves' }, {})
  expect(pending.content[0].text).toContain('job_id "connection:request-1"')
  const done = await getVideoTool.handler({ job_id: 'connection:request-1' }, {})
  expect(waitForVideo).toHaveBeenLastCalledWith('connection:request-1', 240_000)
  expect(done.content[0].text).toContain('/workspace/media/grok-1.mp4')
})

it('reports a failed video', async () => {
  waitForVideo.mockRejectedValueOnce(new Error('the video was withheld by moderation'))
  const result = await getVideoTool.handler({ job_id: 'connection:request-1' }, {})
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('Grok video generation failed: the video was withheld by moderation.')
  expect(result.content[0].text).toContain('job_id "connection:request-1"')
})

it('keeps the job id when polling fails after the video was created', async () => {
  waitForVideo.mockRejectedValueOnce(new Error('Network error calling grok/video/status'))
  const result = await videoTool.handler({ prompt: 'waves' }, {})
  expect(startVideo).toHaveBeenCalledTimes(1)
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('job_id "connection:request-1"')
  expect(result.content[0].text).toContain('instead of starting a new video')
})

it('has no job id to return when creation itself fails', async () => {
  startVideo.mockRejectedValueOnce(new Error('Grok video limit reached'))
  const result = await videoTool.handler({ prompt: 'waves' }, {})
  expect(result.content[0].text).toBe('Grok video generation failed: Grok video limit reached.')
})
