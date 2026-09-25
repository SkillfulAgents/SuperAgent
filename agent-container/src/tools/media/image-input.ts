import { readFile } from 'node:fs/promises'
import path from 'node:path'

const MIME_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Reads a workspace image as a data URL for a provider edit/reference input. */
export async function imageDataUrl(file: string): Promise<string> {
  const mimeType = MIME_TYPES[path.extname(file).toLowerCase()]
  if (!mimeType) throw new Error(`${file} is not a PNG, JPEG or WebP image`)
  const bytes = await readFile(file)
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${file} is larger than 20 MB`)
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}
