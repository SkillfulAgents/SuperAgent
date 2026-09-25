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
  extraPrompt: `Codex subscription image generation is available, regardless of the current chat model. Use existing Bash tools to call the host API; there is no dedicated media tool.
Use Codex when requested. If several media providers are available and the user did not specify one, ask which to use. This uses the connected ChatGPT subscription's Codex allowance, not platform credits.
POST to process.env.SUPERAGENT_HOST_API_URL (remove its trailing slash) + "/subscription-media/codex/image", with Authorization: Bearer <process.env.PROXY_TOKEN> and Content-Type: application/json. Read these variables in your script; never print tokens or request subscription credentials. Allow up to 6 minutes for the response.
Request JSON: {"prompt":"A red square on a white background","transparentBackground":false,"images":[]}
prompt is required. transparentBackground defaults to false. For editing, images accepts up to 5 PNG, JPEG or WebP data URLs (data:image/png;base64,...), not file paths or remote URLs. Read reference files locally, keep each under 20 MB, and encode them in the script. Model, size and quality are fixed by the host (gpt-image-2, auto).
A successful response is {"images":[{"mimeType":"image/png","base64":"..."}]}. Validate the response, decode base64, and save each image with a unique filename under /workspace/media/ using mimeType for the extension. Print only saved paths, never base64 or the full response. Deliver saved files with the existing file-delivery tool; reuse them instead of regenerating.
On a non-2xx response, report its JSON error. Do not automatically retry generation after a timeout or network failure: the first request may already have consumed allowance.`,
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
