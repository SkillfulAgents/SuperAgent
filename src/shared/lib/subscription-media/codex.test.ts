import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexMediaProvider } from './codex'
import { MediaRequestError } from './types'

const PNG = Buffer.from('\x89PNG fake').toString('base64')
const fetchMock = vi.fn<typeof fetch>()

function credentialSource(accountId: string | undefined = 'account-1') {
  return vi.fn(async (rejectedGeneration?: number) => ({
    accessToken: rejectedGeneration === undefined ? 'old-token' : 'new-token',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000,
    accountId,
    generation: rejectedGeneration === undefined ? 1 : 2,
  }))
}
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
})

it('generates with the official Codex image request', async () => {
  fetchMock.mockResolvedValueOnce(json(200, { created: 1, data: [{ b64_json: PNG }] }))
  const images = await codexMediaProvider.generateImage({ prompt: 'a red square' }, credentialSource())
  expect(images).toEqual([{ mimeType: 'image/png', base64: PNG }])
  const request = sent()
  expect(request.url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
  expect(request.body).toEqual({ prompt: 'a red square', background: 'opaque', model: 'gpt-image-2', quality: 'auto', size: 'auto' })
  expect(request.headers.get('authorization')).toBe('Bearer old-token')
  expect(request.headers.get('chatgpt-account-id')).toBe('account-1')
  expect(request.headers.get('originator')).toBe('codex_cli_rs')
})

it('edits referenced images with a transparent background', async () => {
  fetchMock.mockResolvedValueOnce(json(200, { created: 1, data: [{ b64_json: '/9j/jpeg' }] }))
  const image = 'data:image/png;base64,Zm9v'
  const images = await codexMediaProvider.generateImage({ prompt: 'make it blue', transparentBackground: true, images: [image] }, credentialSource())
  expect(images[0].mimeType).toBe('image/jpeg')
  const request = sent()
  expect(request.url).toBe('https://chatgpt.com/backend-api/codex/images/edits')
  expect(request.body).toMatchObject({ images: [{ image_url: image }], background: 'transparent' })
})

it('retries once with a refreshed credential after a 401', async () => {
  fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { created: 1, data: [{ b64_json: PNG }] }))
  const credential = credentialSource()
  await codexMediaProvider.generateImage({ prompt: 'a red square' }, credential)
  expect(credential).toHaveBeenLastCalledWith(1)
  expect(sent(1).headers.get('authorization')).toBe('Bearer new-token')
})

it('returns agent-safe errors for limits, rejected prompts and invalid input', async () => {
  fetchMock.mockResolvedValueOnce(json(429, { error: { message: 'image_gen limit' } }))
  await expect(codexMediaProvider.generateImage({ prompt: 'x' }, credentialSource())).rejects.toMatchObject({ status: 429, message: 'Codex image limit reached: image_gen limit' })
  fetchMock.mockResolvedValueOnce(json(400, { detail: 'content policy' }))
  await expect(codexMediaProvider.generateImage({ prompt: 'x' }, credentialSource())).rejects.toMatchObject({ status: 400, message: 'Codex rejected the image request: content policy' })
  fetchMock.mockResolvedValueOnce(json(500, { error: { message: 'internal stack' } }))
  await expect(codexMediaProvider.generateImage({ prompt: 'x' }, credentialSource())).rejects.toMatchObject({ status: 502, message: 'Codex image generation failed (500)' })
  await expect(codexMediaProvider.generateImage({ prompt: ' ' }, credentialSource())).rejects.toBeInstanceOf(MediaRequestError)
  await expect(codexMediaProvider.generateImage({ prompt: 'x', images: ['file:///etc/passwd'] }, credentialSource())).rejects.toMatchObject({ status: 400 })
  await expect(codexMediaProvider.generateImage({ prompt: 'x' }, credentialSource(''))).rejects.toMatchObject({ status: 400 })
  expect(fetchMock).toHaveBeenCalledTimes(3)
})
