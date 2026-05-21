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

export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  return ct.includes('application/json') || /\+json(\s*;|\s*$)/.test(ct)
}

export function isBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  if (ct.startsWith('text/')) return false
  if (isJsonContentType(ct)) return false
  if (ct.startsWith('application/x-www-form-urlencoded')) return false
  if (ct.startsWith('multipart/')) return false
  return true
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
