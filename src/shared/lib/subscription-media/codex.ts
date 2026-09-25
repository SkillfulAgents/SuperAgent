import { z } from 'zod'
import { CODEX_BASE_URL, CODEX_HEADERS } from '../llm-provider/codex-subscription-provider'
import { MediaRequestError, type GeneratedMedia, type MediaCredentialSource, type SubscriptionMediaProvider } from './types'
import { sendWithCredential, upstreamMediaError } from './upstream'
import { imageMimeType, referenceImagesSchema } from './image-data'

// Mirrors the official Codex image tool: gpt-image-2 with automatic size and quality.
const IMAGE_MODEL = 'gpt-image-2'

const inputSchema = z.object({
  prompt: z.string().trim().min(1),
  transparentBackground: z.boolean().default(false),
  images: referenceImagesSchema,
})
const responseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) })

export const codexMediaProvider: SubscriptionMediaProvider = {
  id: 'codex',
  name: 'Codex',
  llmProviderId: 'codex-subscription',
  async generateImage(raw: unknown, credential: MediaCredentialSource): Promise<GeneratedMedia[]> {
    const parsed = inputSchema.safeParse(raw)
    if (!parsed.success) throw new MediaRequestError(400, `Invalid Codex image request: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    const { prompt, transparentBackground, images } = parsed.data
    const path = images.length > 0 ? 'images/edits' : 'images/generations'
    const body = JSON.stringify({
      ...(images.length > 0 ? { images: images.map(image_url => ({ image_url })) } : {}),
      prompt,
      background: transparentBackground ? 'transparent' : 'opaque',
      model: IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    })
    const response = await sendWithCredential(credential, current => {
      if (!current.accountId) throw new MediaRequestError(400, 'Reconnect Codex to select a subscription account')
      return fetch(`${CODEX_BASE_URL}/${path}`, {
        method: 'POST',
        headers: { ...CODEX_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${current.accessToken}`, 'ChatGPT-Account-ID': current.accountId },
        body,
        signal: AbortSignal.timeout(300_000),
        redirect: 'error',
      })
    })
    if (!response.ok) throw await upstreamMediaError('Codex', response)
    return responseSchema.parse(await response.json()).data.map(({ b64_json }) => ({ mimeType: imageMimeType(b64_json), base64: b64_json }))
  },
}
