import { Hono } from 'hono'
import { getSettings } from '@shared/lib/config/settings'
import {
  DEFAULT_WEB_FAVICON_MIME_TYPE,
  DEFAULT_WEB_FAVICON_SVG,
  parseFaviconDataUrl,
} from '@shared/lib/config/favicon'

const favicon = new Hono()

function faviconHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; sandbox",
  }
}

function responseBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(bytes.byteLength)
  body.set(bytes)
  return body
}

favicon.get('/', (c) => {
  const configured = getSettings().app?.faviconDataUrl
  const parsed = configured ? parseFaviconDataUrl(configured) : null

  if (parsed) {
    return c.body(responseBytes(parsed.bytes), 200, faviconHeaders(parsed.mimeType))
  }

  return c.body(DEFAULT_WEB_FAVICON_SVG, 200, faviconHeaders(DEFAULT_WEB_FAVICON_MIME_TYPE))
})

export default favicon
