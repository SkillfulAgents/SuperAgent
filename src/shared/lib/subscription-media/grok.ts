import { z } from 'zod'
import { MediaRequestError, type GeneratedMedia, type MediaCredentialSource, type SubscriptionMediaProvider, type VideoJobStatus } from './types'
import { sendWithCredential, upstreamMediaError } from './upstream'
import { imageDataUrlSchema, imageMimeType, referenceImagesSchema } from './image-data'
import { GROK_CLIENT_HEADERS, GROK_SUBSCRIPTION_BASE_URL } from '../llm-provider/grok-subscription-provider'

// OAuth media must use the subscription proxy: api.x.ai bills the developer
// account and rejects subscribers with 403 spending-limit (CLIProxyAPI #5335).
const GROK_MEDIA_BASE_URL = `${GROK_SUBSCRIPTION_BASE_URL}/v1`
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const IMAGE_MODEL = 'grok-imagine-image-2.0'
const VIDEO_MODEL = 'grok-imagine-video-1.5'
const MAX_VIDEO_BYTES = 100 * 1024 * 1024

export const GROK_IMAGE_ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '21:9'] as const
export const GROK_IMAGE_RESOLUTIONS = ['1k', '2k'] as const
export const GROK_VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const
export const GROK_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const

const inputSchema = z.object({
  prompt: z.string().trim().min(1),
  aspectRatio: z.enum(GROK_IMAGE_ASPECT_RATIOS).optional(),
  resolution: z.enum(GROK_IMAGE_RESOLUTIONS).optional(),
  images: referenceImagesSchema,
})
const videoInputSchema = z.object({
  prompt: z.string().trim().min(1),
  image: imageDataUrlSchema.optional(),
  duration: z.number().int().min(1).max(15).optional(),
  aspectRatio: z.enum(GROK_VIDEO_ASPECT_RATIOS).optional(),
  resolution: z.enum(GROK_VIDEO_RESOLUTIONS).optional(),
})
const videoStartSchema = z.object({ request_id: z.string().regex(/^[\w-]+$/) })
const videoStatusSchema = z.object({
  status: z.string().optional(),
  video: z.object({ url: z.string().optional(), respect_moderation: z.boolean().optional() }).optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
})
const DONE = new Set(['done', 'succeeded', 'success', 'completed'])
const FAILED = new Set(['failed', 'error', 'expired', 'cancelled', 'canceled'])

function request(path: string, credential: MediaCredentialSource, init: RequestInit = {}) {
  return sendWithCredential(credential, current => fetch(`${GROK_MEDIA_BASE_URL}/${path}`, {
    ...init,
    headers: { ...GROK_CLIENT_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${current.accessToken}` },
    signal: AbortSignal.timeout(300_000),
    redirect: 'error',
  }))
}

// Result URLs are pre-signed; never send the subscription token to them.
async function download(url: string, mimeType: string, maxBytes: number): Promise<GeneratedMedia> {
  if (!url.startsWith('https://')) throw new MediaRequestError(502, 'Grok returned an invalid media URL')
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new MediaRequestError(502, `Grok media download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new MediaRequestError(502, `Grok media is larger than ${maxBytes / 1024 / 1024} MB`)
  return { mimeType, base64: bytes.toString('base64') }
}

const responseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1).optional(), url: z.string().optional(), mime_type: z.string().optional() })).min(1),
})

export const grokMediaProvider: SubscriptionMediaProvider = {
  id: 'grok',
  name: 'Grok',
  llmProviderId: 'grok-subscription',
  async generateImage(raw: unknown, credential: MediaCredentialSource): Promise<GeneratedMedia[]> {
    const parsed = inputSchema.safeParse(raw)
    if (!parsed.success) throw new MediaRequestError(400, `Invalid Grok image request: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    const { prompt, aspectRatio, resolution, images } = parsed.data
    const path = images.length > 0 ? 'images/edits' : 'images/generations'
    const body = JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      response_format: 'b64_json',
      ...(images.length > 0 ? { images: images.map(url => ({ type: 'image_url', url })) } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
    })
    const response = await request(path, credential, { method: 'POST', body })
    if (!response.ok) throw await upstreamMediaError('Grok', response)
    // The subscription proxy may return a URL even when base64 is requested.
    return Promise.all(responseSchema.parse(await response.json()).data.map(item => {
      if (item.b64_json) return { mimeType: item.mime_type ?? imageMimeType(item.b64_json), base64: item.b64_json }
      if (item.url) return download(item.url, item.mime_type ?? 'image/jpeg', MAX_IMAGE_BYTES)
      throw new MediaRequestError(502, 'Grok returned an image without data')
    }))
  },
  async startVideo(raw: unknown, credential: MediaCredentialSource): Promise<string> {
    const parsed = videoInputSchema.safeParse(raw)
    if (!parsed.success) throw new MediaRequestError(400, `Invalid Grok video request: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    const { prompt, image, duration, aspectRatio, resolution } = parsed.data
    const response = await request('videos/generations', credential, {
      method: 'POST',
      body: JSON.stringify({
        model: VIDEO_MODEL,
        prompt,
        ...(image ? { image: { url: image } } : {}),
        ...(duration ? { duration } : {}),
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(resolution ? { resolution } : {}),
      }),
    })
    if (!response.ok) throw await upstreamMediaError('Grok', response, 'video')
    return videoStartSchema.parse(await response.json()).request_id
  },
  async getVideo(requestId: string, credential: MediaCredentialSource): Promise<VideoJobStatus> {
    if (!/^[\w-]+$/.test(requestId)) throw new MediaRequestError(400, 'Invalid Grok video job')
    const response = await request(`videos/${requestId}`, credential)
    if (!response.ok) throw await upstreamMediaError('Grok', response, 'video')
    const result = videoStatusSchema.parse(await response.json())
    const status = result.status?.toLowerCase() ?? ''
    if (FAILED.has(status)) {
      const error = typeof result.error === 'string' ? result.error : result.error?.message
      return { status: 'failed', error: error ? error.slice(0, 500) : `job ${status}` }
    }
    if (!DONE.has(status) && !result.video) return { status: 'pending' }
    if (result.video?.respect_moderation === false) return { status: 'failed', error: 'the video was withheld by moderation' }
    if (!result.video?.url) return { status: 'failed', error: 'the finished job had no video URL' }
    return { status: 'done', video: await download(result.video.url, 'video/mp4', MAX_VIDEO_BYTES) }
  },
}
