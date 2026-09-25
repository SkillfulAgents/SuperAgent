import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { grokMediaProvider } from './grok'

const fetchMock = vi.fn<typeof fetch>()
const credential = vi.fn(async (rejectedGeneration?: number) => ({
  accessToken: rejectedGeneration === undefined ? 'old-token' : 'new-token',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 60_000,
  generation: rejectedGeneration === undefined ? 1 : 2,
}))
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function sent(index = 0) {
  const [url, init] = fetchMock.mock.calls[index]
  return { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  credential.mockClear()
})

it('generates the documented image request through the subscription proxy', async () => {
  expect(grokMediaProvider.extraPrompt).toContain('/subscription-media/grok/image')
  expect(grokMediaProvider.extraPrompt).toContain('process.env.PROXY_TOKEN')
  const input = JSON.parse(grokMediaProvider.extraPrompt.match(/Image request JSON: (\{.*\})/)![1])
  fetchMock.mockResolvedValueOnce(json(200, { data: [{ b64_json: '/9j/jpeg', mime_type: 'image/jpeg' }] }))
  const images = await grokMediaProvider.generateImage(input, credential)
  expect(images).toEqual([{ mimeType: 'image/jpeg', base64: '/9j/jpeg' }])
  const request = sent()
  expect(request.url).toBe('https://cli-chat-proxy.grok.com/v1/images/generations')
  expect(request.body).toEqual({ model: 'grok-imagine-image-2.0', prompt: 'A red square on a white background', n: 1, response_format: 'b64_json', aspect_ratio: '16:9', resolution: '2k' })
  expect(request.headers.get('authorization')).toBe('Bearer old-token')
  expect(request.headers.get('x-grok-client-mode')).toBe('cli')
})

it('downloads image URLs from the subscription proxy without the token', async () => {
  fetchMock
    .mockResolvedValueOnce(json(200, { data: [{ url: 'https://imgen.x.ai/a.jpeg', mime_type: 'image/jpeg' }] }))
    .mockResolvedValueOnce(new Response('jpeg-bytes'))
  const images = await grokMediaProvider.generateImage({ prompt: 'a red square' }, credential)
  expect(images).toEqual([{ mimeType: 'image/jpeg', base64: Buffer.from('jpeg-bytes').toString('base64') }])
  const download = fetchMock.mock.calls[1]
  expect(String(download[0])).toBe('https://imgen.x.ai/a.jpeg')
  expect(new Headers(download[1]?.headers).get('authorization')).toBeNull()
})

it('edits referenced images', async () => {
  fetchMock.mockResolvedValueOnce(json(200, { data: [{ b64_json: 'iVBORpng' }] }))
  const image = 'data:image/png;base64,Zm9v'
  const images = await grokMediaProvider.generateImage({ prompt: 'make it blue', images: [image] }, credential)
  expect(images[0].mimeType).toBe('image/png')
  const request = sent()
  expect(request.url).toBe('https://cli-chat-proxy.grok.com/v1/images/edits')
  expect(request.body.images).toEqual([{ type: 'image_url', url: image }])
  expect(request.body).not.toHaveProperty('aspect_ratio')
})

it('retries once with a refreshed credential after a 401', async () => {
  fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { data: [{ b64_json: 'iVBORpng' }] }))
  await grokMediaProvider.generateImage({ prompt: 'a red square' }, credential)
  expect(credential).toHaveBeenLastCalledWith(1)
  expect(sent(1).headers.get('authorization')).toBe('Bearer new-token')
})

it('returns xAI string errors and rejects invalid input before calling xAI', async () => {
  fetchMock.mockResolvedValueOnce(json(429, { code: 'rate_limited', error: 'Daily image limit reached' }))
  await expect(grokMediaProvider.generateImage({ prompt: 'x' }, credential)).rejects.toMatchObject({ status: 429, message: 'Grok image limit reached: Daily image limit reached' })
  await expect(grokMediaProvider.generateImage({ prompt: 'x', aspectRatio: '7:3' }, credential)).rejects.toMatchObject({ status: 400 })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('starts the documented video request with an optional first frame', async () => {
  expect(grokMediaProvider.extraPrompt).toContain('/subscription-media/grok/video/status')
  const input = JSON.parse(grokMediaProvider.extraPrompt.match(/Video request JSON: (\{.*\})/)![1])
  fetchMock.mockResolvedValueOnce(json(200, { request_id: 'req-1' }))
  const image = 'data:image/png;base64,Zm9v'
  expect(await grokMediaProvider.startVideo!({ ...input, image }, credential)).toBe('req-1')
  const request = sent()
  expect(request.url).toBe('https://cli-chat-proxy.grok.com/v1/videos/generations')
  expect(request.body).toEqual({ model: 'grok-imagine-video-1.5', prompt: 'Ocean waves moving gently', image: { url: image }, duration: 6, aspect_ratio: '16:9', resolution: '720p' })
  await expect(grokMediaProvider.startVideo!({ prompt: 'waves', duration: 30 }, credential)).rejects.toMatchObject({ status: 400 })
})

it('reports pending, failed and finished video jobs', async () => {
  fetchMock.mockResolvedValueOnce(json(200, { status: 'pending', progress: 40 }))
  expect(await grokMediaProvider.getVideo!('req-1', credential)).toEqual({ status: 'pending' })
  expect(String(fetchMock.mock.calls[0][0])).toBe('https://cli-chat-proxy.grok.com/v1/videos/req-1')

  fetchMock.mockResolvedValueOnce(json(200, { status: 'failed', error: { message: 'content policy' } }))
  expect(await grokMediaProvider.getVideo!('req-1', credential)).toEqual({ status: 'failed', error: 'content policy' })

  fetchMock
    .mockResolvedValueOnce(json(200, { status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } }))
    .mockResolvedValueOnce(new Response('mp4-bytes'))
  expect(await grokMediaProvider.getVideo!('req-1', credential)).toEqual({ status: 'done', video: { mimeType: 'video/mp4', base64: Buffer.from('mp4-bytes').toString('base64') } })
  const download = fetchMock.mock.calls.at(-1)!
  expect(String(download[0])).toBe('https://vidgen.x.ai/v.mp4')
  expect(new Headers(download[1]?.headers).get('authorization')).toBeNull()

  await expect(grokMediaProvider.getVideo!('../files', credential)).rejects.toMatchObject({ status: 400 })
})
