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
  extraPrompt: `Grok subscription image and video generation is available, regardless of the current chat model. Use existing Bash tools to call the host API; there are no dedicated media tools.
Use Grok when requested. If several media providers are available and the user did not specify one, ask which to use. Generation uses the connected Grok subscription's allowance, not platform credits.
Use process.env.SUPERAGENT_HOST_API_URL (remove its trailing slash) as the base URL for the following POST endpoints, with Authorization: Bearer <process.env.PROXY_TOKEN> and Content-Type: application/json. Read these variables in your script; never print tokens or request subscription credentials. Allow several minutes for generation/download responses.
Images: POST /subscription-media/grok/image (Grok Imagine).
Image request JSON: {"prompt":"A red square on a white background","aspectRatio":"16:9","resolution":"2k","images":[]}
prompt is required; the other fields are optional. aspectRatio accepts ${GROK_IMAGE_ASPECT_RATIOS.join(', ')}; resolution accepts ${GROK_IMAGE_RESOLUTIONS.join(', ')}. For editing, images accepts up to 5 PNG, JPEG or WebP data URLs (data:image/png;base64,...), not file paths or remote URLs. Read reference files locally, keep each under 20 MB, and encode them in the script.
The image response is {"images":[{"mimeType":"image/jpeg","base64":"..."}]}. Validate it, decode base64 and save each image with a unique filename under /workspace/media/ using mimeType for the extension. Print only saved paths, never base64 or the full response; deliver saved files with the existing file-delivery tool.
Videos: POST /subscription-media/grok/video (Grok Imagine).
Video request JSON: {"prompt":"Ocean waves moving gently","duration":6,"aspectRatio":"16:9","resolution":"720p"}
prompt is required. Optional fields: duration (integer 1–15 seconds), aspectRatio (${GROK_VIDEO_ASPECT_RATIOS.join(', ')}), resolution (${GROK_VIDEO_RESOLUTIONS.join(', ')}), image (a PNG/JPEG/WebP data URL for the first frame).
The start response is {"job":"..."}. Save the complete job handle to a uniquely named file under /workspace/media/ and print it BEFORE polling. POST /subscription-media/grok/video/status with {"job":"the saved handle"} every 5 seconds. Responses: {"status":"pending"}, {"status":"failed","error":"..."}, or {"status":"done","video":{"mimeType":"video/mp4","base64":"..."}}. Decode a finished video to a unique .mp4 file and print only its path. After about 4 minutes, return the saved handle and resume polling it in a later Bash call.
On polling/download errors, keep the saved handle and retry status rather than starting another video. On non-2xx responses, report the JSON error; a 409 means the connection changed. Do not automatically retry image generation or video creation after a timeout/network failure, since the first request may already have consumed allowance.`,
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
