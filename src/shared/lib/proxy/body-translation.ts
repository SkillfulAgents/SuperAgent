/**
 * Translate an incoming HTTP request body into the shape Composio's proxy
 * execute endpoint expects (`body` for JSON, `binary_body` for binary uploads).
 *
 * This path only runs for connections whose tokens are redacted (Composio-managed).
 * User-managed connections pass through the original body unchanged on the
 * direct-fetch path.
 */

export type ProxyBinaryBody = { base64: string; content_type: string }

export type ProxyBodyResult =
  | { ok: true; body?: unknown; binaryBody?: ProxyBinaryBody }
  | {
      ok: false
      status: 400 | 415
      errorCode: 'invalid_json' | 'unsupported_media_type'
      message: string
    }

export const MAX_PROXY_BINARY_BYTES = 4 * 1024 * 1024

/** The media type alone, lowercased: parameters such as `name=data.json` never decide the class. */
function mediaTypeOf(contentType: string | null | undefined): string {
  return contentType?.split(';')[0].trim().toLowerCase() ?? ''
}

export function isJsonContentType(contentType: string | null): boolean {
  const mediaType = mediaTypeOf(contentType)
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

export function isBinaryContentType(contentType: string | null): boolean {
  const mediaType = mediaTypeOf(contentType)
  if (!mediaType) return false
  if (mediaType.startsWith('text/')) return false
  if (isJsonContentType(mediaType)) return false
  if (mediaType === 'application/x-www-form-urlencoded') return false
  // Drive's single-request upload is an opaque multipart/related byte stream.
  if (mediaType === 'multipart/related') return true
  if (mediaType.startsWith('multipart/')) return false
  return true
}

const TEXT_MEDIA_TYPE = /^(text\/.+|application\/(x-www-form-urlencoded|x-ndjson|graphql|xml)|[a-z]+\/.+\+xml)$/

/** Whether the approval card can show a body of this content type as text. */
export function isPreviewableContentType(contentType: string | null | undefined): boolean {
  const mediaType = mediaTypeOf(contentType)
  return isJsonContentType(mediaType) || TEXT_MEDIA_TYPE.test(mediaType)
}

export function translateProxyBody(
  method: string,
  contentType: string | null,
  body: ArrayBuffer
): ProxyBodyResult {
  if (method === 'GET' || method === 'HEAD') return { ok: true }
  if (body.byteLength === 0) return { ok: true }

  if (isJsonContentType(contentType)) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body))
      return { ok: true, body: parsed }
    } catch {
      return {
        ok: false,
        status: 400,
        errorCode: 'invalid_json',
        message: 'Invalid JSON body for Composio-managed connection',
      }
    }
  }

  if (isBinaryContentType(contentType)) {
    if (body.byteLength > MAX_PROXY_BINARY_BYTES) {
      return {
        ok: false,
        status: 415,
        errorCode: 'unsupported_media_type',
        message: `Body exceeds ${MAX_PROXY_BINARY_BYTES} byte limit for Composio-managed connections.`,
      }
    }
    return {
      ok: true,
      binaryBody: {
        base64: Buffer.from(body).toString('base64'),
        content_type: contentType ?? 'application/octet-stream',
      },
    }
  }

  return {
    ok: false,
    status: 415,
    errorCode: 'unsupported_media_type',
    message: `Content-Type "${contentType ?? 'unknown'}" is not supported on Composio-managed connections. Use application/json or a binary upload, or migrate this account to a custom auth config (your own OAuth app) for full pass-through.`,
  }
}
