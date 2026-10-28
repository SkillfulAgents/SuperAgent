export const FAVICON_MAX_BYTES = 256 * 1024

export const ALLOWED_FAVICON_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
] as const

export type FaviconMimeType = (typeof ALLOWED_FAVICON_MIME_TYPES)[number]

const ALLOWED_FAVICON_MIME_TYPE_SET = new Set<string>(ALLOWED_FAVICON_MIME_TYPES)

export const DEFAULT_WEB_FAVICON_MIME_TYPE = 'image/svg+xml'

export const DEFAULT_WEB_FAVICON_SVG = `<svg width="600" height="600" viewBox="0 0 600 600" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="600" height="600" rx="132" fill="#111827"/>
<g transform="translate(35 35) scale(0.88)">
<path d="M78.0056 314.341C100.937 354.026 131.37 393.855 168.486 430.971C208.357 470.841 251.358 503 293.949 526.432C266.624 554.832 228.44 572.471 186.187 572.471C103.108 572.471 35.7585 504.282 35.7585 420.167C35.7586 379.052 51.851 341.742 78.0056 314.341ZM62.0544 61.4181C134.713 -11.2404 300.168 36.4105 431.607 167.85C563.046 299.289 610.697 464.744 538.039 537.402C487.42 588.021 391.765 580.247 293.949 526.432C320.351 498.991 336.616 461.502 336.616 420.167C336.616 336.052 269.266 267.864 186.187 267.863C143.717 267.863 105.359 285.684 78.0056 314.341C19.7299 213.488 9.91302 113.56 62.0544 61.4181Z" fill="white"/>
</g>
</svg>`

export interface ParsedFaviconDataUrl {
  mimeType: FaviconMimeType
  bytes: Buffer
}

export type FaviconValidationResult =
  | { ok: true }
  | { ok: false; error: string }

function isUnsafeSvg(svg: string): boolean {
  return (
    /<\s*(script|foreignObject)\b/i.test(svg) ||
    /\son[a-z]+\s*=/i.test(svg) ||
    /javascript\s*:/i.test(svg)
  )
}

export function parseFaviconDataUrl(value: string): ParsedFaviconDataUrl | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return null

  const mimeType = match[1].toLowerCase()
  if (!ALLOWED_FAVICON_MIME_TYPE_SET.has(mimeType)) return null

  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > FAVICON_MAX_BYTES) return null

  if (mimeType === 'image/svg+xml') {
    const svg = bytes.toString('utf8')
    if (!/<svg[\s>]/i.test(svg) || isUnsafeSvg(svg)) return null
  }

  return { mimeType: mimeType as FaviconMimeType, bytes }
}

export function validateFaviconDataUrl(value: unknown): FaviconValidationResult {
  if (value === undefined || value === null || value === '') {
    return { ok: true }
  }

  if (typeof value !== 'string') {
    return { ok: false, error: 'faviconDataUrl must be a data URL string' }
  }

  if (!parseFaviconDataUrl(value)) {
    return {
      ok: false,
      error: `Favicon must be a ${ALLOWED_FAVICON_MIME_TYPES.join(', ')} image up to ${FAVICON_MAX_BYTES / 1024}KB`,
    }
  }

  return { ok: true }
}
