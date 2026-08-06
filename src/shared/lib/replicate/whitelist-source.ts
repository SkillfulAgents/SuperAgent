import { z } from 'zod'
import { sourceEntrySchema, type SourceEntry } from './replicate-schema'

/**
 * The approved model list, pinned model by model. `official` is not authored here —
 * scripts/fetch-replicate-whitelist.ts resolves it from the vendor, because it decides
 * which create path an agent must use and a wrong guess breaks that model silently.
 *
 * Deliberately small, and this list is the whole gate: a model runs only by appearing
 * here. Extend it when a job has no good answer, not to match the vendor's catalog.
 *
 * Nothing is collection-backed. Expanding a vendor collection hands membership to the
 * vendor, who files voice cloning under text-to-speech and general chat models under
 * captioning — so the three standing calls below would survive only until the next
 * regeneration. Pinned, they hold by construction:
 *
 * - no identity or voice impersonation
 * - no general-purpose language models
 * - nothing the agent already does with its own model, image reading included
 */
const RAW_SOURCE: SourceEntry[] = [
  { model: 'black-forest-labs/flux-1.1-pro-ultra', category: 'Image generation' },
  { model: 'black-forest-labs/flux-schnell', category: 'Image generation' },
  { model: 'google/nano-banana-pro', category: 'Image generation' },
  { model: 'bytedance/seedream-4.5', category: 'Image generation' },
  { model: 'ideogram-ai/ideogram-v3-quality', category: 'Image generation' },
  { model: 'recraft-ai/recraft-v3-svg', category: 'Image generation' },
  // Recover a generation prompt from an image — feeds the models above.
  { model: 'pharmapsychotic/clip-interrogator', category: 'Image generation' },
  { model: 'methexis-inc/img2prompt', category: 'Image generation' },
  { model: 'black-forest-labs/flux-kontext-dev', category: 'Image editing' },
  { model: 'qwen/qwen-image-edit-plus', category: 'Image editing' },
  { model: 'bria/eraser', category: 'Image editing' },
  { model: 'philz1337x/clarity-upscaler', category: 'Upscaling' },
  { model: 'topazlabs/image-upscale', category: 'Upscaling' },
  { model: 'lucataco/codeformer', category: 'Photo restoration' },
  { model: 'microsoft/bringing-old-photos-back-to-life', category: 'Photo restoration' },
  { model: 'bria/remove-background', category: 'Background removal' },
  { model: 'men1scus/birefnet', category: 'Background removal' },
  { model: 'elevenlabs/v3', category: 'Text-to-speech' },
  { model: 'jaaari/kokoro-82m', category: 'Text-to-speech' },
  { model: 'minimax/speech-2.8-hd', category: 'Text-to-speech' },
  { model: 'wan-video/wan-2.2-i2v-fast', category: 'Video' },
  { model: 'bytedance/seedance-1-lite', category: 'Video' },
  { model: 'kwaivgi/kling-v2.5-turbo-pro', category: 'Video' },
  { model: 'google/lyria-2', category: 'Music' },
  { model: 'minimax/music-1.5', category: 'Music' },
  { model: 'meta/musicgen', category: 'Music' },
]

export const WHITELIST_SOURCE: SourceEntry[] = z.array(sourceEntrySchema).parse(RAW_SOURCE)
