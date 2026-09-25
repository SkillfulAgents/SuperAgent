import { z } from 'zod'
import { MediaRequestError, type GeneratedMedia, type MediaCredentialSource, type SubscriptionMediaProvider } from './types'
import { sendWithCredential, upstreamMediaError } from './upstream'
import { imageMimeType, referenceImagesSchema } from './image-data'

// The subscription OAuth grant includes `api:access`, which the public xAI API accepts.
const GROK_API_BASE_URL = 'https://api.x.ai/v1'
const IMAGE_MODEL = 'grok-imagine-image-2.0'

export const GROK_IMAGE_ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '21:9'] as const
export const GROK_IMAGE_RESOLUTIONS = ['1k', '2k'] as const

const inputSchema = z.object({
  prompt: z.string().trim().min(1),
  aspectRatio: z.enum(GROK_IMAGE_ASPECT_RATIOS).optional(),
  resolution: z.enum(GROK_IMAGE_RESOLUTIONS).optional(),
  images: referenceImagesSchema,
})
const responseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1), mime_type: z.string().optional() })).min(1),
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
    const response = await sendWithCredential(credential, current => fetch(`${GROK_API_BASE_URL}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${current.accessToken}` },
      body,
      signal: AbortSignal.timeout(300_000),
      redirect: 'error',
    }))
    if (!response.ok) throw await upstreamMediaError('Grok', response)
    return responseSchema.parse(await response.json()).data.map(item => ({
      mimeType: item.mime_type ?? imageMimeType(item.b64_json),
      base64: item.b64_json,
    }))
  },
}
