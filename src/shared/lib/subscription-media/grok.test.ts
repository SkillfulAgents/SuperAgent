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

it('generates one inline image through the xAI images API', async () => {
  fetchMock.mockResolvedValueOnce(json(200, { data: [{ b64_json: '/9j/jpeg', mime_type: 'image/jpeg' }] }))
  const images = await grokMediaProvider.generateImage({ prompt: 'a red square', aspectRatio: '16:9', resolution: '2k' }, credential)
  expect(images).toEqual([{ mimeType: 'image/jpeg', base64: '/9j/jpeg' }])
  const request = sent()
  expect(request.url).toBe('https://api.x.ai/v1/images/generations')
  expect(request.body).toEqual({ model: 'grok-imagine-image-2.0', prompt: 'a red square', n: 1, response_format: 'b64_json', aspect_ratio: '16:9', resolution: '2k' })
  expect(request.headers.get('authorization')).toBe('Bearer old-token')
})

it('edits referenced images', async () => {
  fetchMock.mockResolvedValueOnce(json(200, { data: [{ b64_json: 'iVBORpng' }] }))
  const image = 'data:image/png;base64,Zm9v'
  const images = await grokMediaProvider.generateImage({ prompt: 'make it blue', images: [image] }, credential)
  expect(images[0].mimeType).toBe('image/png')
  const request = sent()
  expect(request.url).toBe('https://api.x.ai/v1/images/edits')
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
