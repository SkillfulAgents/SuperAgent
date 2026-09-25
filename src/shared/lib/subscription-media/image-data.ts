import { z } from 'zod'

export const referenceImagesSchema = z.array(z.string().regex(/^data:image\/(png|jpeg|webp);base64,/)).max(5).default([])

export function imageMimeType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}
