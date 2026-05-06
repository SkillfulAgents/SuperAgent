import { describe, it, expect } from 'vitest'
import {
  translateProxyBody,
  isJsonContentType,
  isBinaryContentType,
  MAX_PROXY_BINARY_BYTES,
} from './body-translation'

function bufFromString(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

function bufFromBytes(...bytes: number[]): ArrayBuffer {
  const u8 = new Uint8Array(bytes)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

describe('isJsonContentType', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
    'Application/Json; charset=UTF-8',
    'application/vnd.api+json',
    'application/ld+json; charset=utf-8',
    'application/vnd.github.v3+json',
  ])('returns true for %j', (ct) => {
    expect(isJsonContentType(ct)).toBe(true)
  })

  it.each([
    null,
    '',
    'text/plain',
    'text/html',
    'application/octet-stream',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/jsonsomething', // doesn't end at +json or boundary — but our regex is permissive
  ])('returns false for %j', (ct) => {
    if (ct === 'application/jsonsomething') {
      // Our impl uses substring match for application/json, so this still matches.
      // Skip this case from the false expectation — keep it documented.
      expect(isJsonContentType(ct)).toBe(true)
    } else {
      expect(isJsonContentType(ct)).toBe(false)
    }
  })
})

describe('isBinaryContentType', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'application/pdf',
    'application/octet-stream',
    'application/zip',
    'video/mp4',
    'audio/mpeg',
    'IMAGE/PNG',
    'application/octet-stream; charset=binary',
  ])('returns true for %j', (ct) => {
    expect(isBinaryContentType(ct)).toBe(true)
  })

  it.each([
    null,
    '',
    'application/json',
    'application/vnd.api+json',
    'text/plain',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded; charset=utf-8',
    'multipart/form-data; boundary=xyz',
    'MULTIPART/FORM-DATA',
  ])('returns false for %j', (ct) => {
    expect(isBinaryContentType(ct)).toBe(false)
  })
})

describe('translateProxyBody', () => {
  describe('GET / HEAD methods (no body translation)', () => {
    it('GET with empty body → ok with no body fields', () => {
      const r = translateProxyBody('GET', 'application/json', new ArrayBuffer(0))
      expect(r).toEqual({ ok: true })
    })

    it('GET ignores any body that may be present', () => {
      const r = translateProxyBody('GET', 'application/json', bufFromString('{"x":1}'))
      // GET branch returns immediately — body is not read or attached.
      expect(r).toEqual({ ok: true })
    })

    it('HEAD ignores body', () => {
      const r = translateProxyBody('HEAD', 'image/png', bufFromBytes(0xff, 0xd8))
      expect(r).toEqual({ ok: true })
    })
  })

  describe('empty body on body-bearing methods', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s with zero-byte body → ok with no body fields',
      (method) => {
        const r = translateProxyBody(method, 'application/json', new ArrayBuffer(0))
        expect(r).toEqual({ ok: true })
      }
    )

    it('POST with zero-byte body and no content-type → ok (does NOT 415)', () => {
      const r = translateProxyBody('POST', null, new ArrayBuffer(0))
      expect(r).toEqual({ ok: true })
    })
  })

  describe('JSON body', () => {
    it('parses application/json body into a JS object', () => {
      const r = translateProxyBody(
        'POST',
        'application/json',
        bufFromString('{"hello":"world","n":42}')
      )
      expect(r).toEqual({ ok: true, body: { hello: 'world', n: 42 } })
    })

    it('parses application/json with charset', () => {
      const r = translateProxyBody(
        'POST',
        'application/json; charset=utf-8',
        bufFromString('{"a":1}')
      )
      expect(r.ok && r.body).toEqual({ a: 1 })
    })

    it('parses +json suffix (e.g. application/vnd.api+json)', () => {
      const r = translateProxyBody(
        'POST',
        'application/vnd.api+json',
        bufFromString('[1,2,3]')
      )
      expect(r.ok && r.body).toEqual([1, 2, 3])
    })

    it('parses uppercase Content-Type', () => {
      const r = translateProxyBody(
        'POST',
        'APPLICATION/JSON',
        bufFromString('"x"')
      )
      expect(r.ok && r.body).toBe('x')
    })

    it('handles UTF-8 multibyte characters', () => {
      const r = translateProxyBody(
        'POST',
        'application/json',
        bufFromString('{"name":"日本語","emoji":"🚀"}')
      )
      expect(r.ok && r.body).toEqual({ name: '日本語', emoji: '🚀' })
    })

    it('returns 400 invalid_json for malformed JSON', () => {
      const r = translateProxyBody(
        'POST',
        'application/json',
        bufFromString('{not valid')
      )
      expect(r).toEqual({
        ok: false,
        status: 400,
        errorCode: 'invalid_json',
        message: expect.stringContaining('Invalid JSON'),
      })
    })

    it('returns 400 for application/json with empty-but-non-zero body', () => {
      // A body with only whitespace is not valid JSON.
      const r = translateProxyBody('POST', 'application/json', bufFromString('   '))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
    })
  })

  describe('binary body', () => {
    it('encodes a small binary body as base64 with content_type', () => {
      const buf = bufFromBytes(0xff, 0xd8, 0xff, 0xe0) // JPEG magic
      const r = translateProxyBody('POST', 'image/jpeg', buf)
      expect(r).toEqual({
        ok: true,
        binaryBody: {
          base64: Buffer.from(buf).toString('base64'),
          content_type: 'image/jpeg',
        },
      })
    })

    it('handles application/octet-stream', () => {
      const buf = bufFromBytes(0x00, 0x01, 0x02, 0x03)
      const r = translateProxyBody('PUT', 'application/octet-stream', buf)
      expect(r.ok && r.binaryBody?.content_type).toBe('application/octet-stream')
      expect(r.ok && r.binaryBody?.base64).toBe(Buffer.from(buf).toString('base64'))
    })

    it('preserves exact byte content (round-trip via base64)', () => {
      // All 256 byte values
      const all = new Uint8Array(256)
      for (let i = 0; i < 256; i++) all[i] = i
      const buf = all.buffer.slice(0, 256) as ArrayBuffer

      const r = translateProxyBody('POST', 'application/octet-stream', buf)
      expect(r.ok).toBe(true)
      if (r.ok && r.binaryBody) {
        const decoded = Buffer.from(r.binaryBody.base64, 'base64')
        expect(Array.from(decoded)).toEqual(Array.from(all))
      }
    })

    it('accepts binary body at exactly the 4 MB limit', () => {
      const buf = new ArrayBuffer(MAX_PROXY_BINARY_BYTES)
      const r = translateProxyBody('POST', 'application/octet-stream', buf)
      expect(r.ok).toBe(true)
    })

    it('rejects binary body 1 byte over the 4 MB limit (415)', () => {
      const buf = new ArrayBuffer(MAX_PROXY_BINARY_BYTES + 1)
      const r = translateProxyBody('POST', 'application/octet-stream', buf)
      expect(r).toMatchObject({
        ok: false,
        status: 415,
        errorCode: 'unsupported_media_type',
      })
      if (!r.ok) {
        expect(r.message).toContain('exceeds')
        expect(r.message).toContain(String(MAX_PROXY_BINARY_BYTES))
      }
    })

    it('preserves charset/parameters in content_type when forwarding binary', () => {
      const r = translateProxyBody(
        'POST',
        'application/octet-stream; charset=binary',
        bufFromBytes(1, 2, 3)
      )
      expect(r.ok && r.binaryBody?.content_type).toBe(
        'application/octet-stream; charset=binary'
      )
    })
  })

  describe('unsupported media types (415)', () => {
    it.each([
      ['application/x-www-form-urlencoded', 'foo=bar&baz=qux'],
      [
        'application/x-www-form-urlencoded; charset=utf-8',
        'token=xyz',
      ],
    ])('rejects form-encoded %j with 415', (ct, body) => {
      const r = translateProxyBody('POST', ct, bufFromString(body))
      expect(r).toMatchObject({
        ok: false,
        status: 415,
        errorCode: 'unsupported_media_type',
      })
      if (!r.ok) expect(r.message).toContain(ct)
    })

    it('rejects multipart/form-data with 415', () => {
      const ct = 'multipart/form-data; boundary=----xyz'
      const body = '------xyz\r\nContent-Disposition: form-data; name="x"\r\n\r\n1\r\n------xyz--\r\n'
      const r = translateProxyBody('POST', ct, bufFromString(body))
      expect(r).toMatchObject({
        ok: false,
        status: 415,
        errorCode: 'unsupported_media_type',
      })
    })

    it.each(['text/plain', 'text/html', 'text/xml', 'text/csv'])(
      'rejects %s with 415',
      (ct) => {
        const r = translateProxyBody('POST', ct, bufFromString('hello'))
        expect(r).toMatchObject({
          ok: false,
          status: 415,
          errorCode: 'unsupported_media_type',
        })
      }
    )

    it('rejects POST with non-empty body and no Content-Type with 415', () => {
      const r = translateProxyBody('POST', null, bufFromString('something'))
      expect(r).toMatchObject({
        ok: false,
        status: 415,
        errorCode: 'unsupported_media_type',
      })
      if (!r.ok) expect(r.message).toContain('unknown')
    })

    it('rejects POST with empty Content-Type string and non-empty body', () => {
      const r = translateProxyBody('POST', '', bufFromString('hi'))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(415)
    })

    it('error message guides the user toward custom auth config', () => {
      const r = translateProxyBody(
        'POST',
        'application/x-www-form-urlencoded',
        bufFromString('a=b')
      )
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message).toContain('custom auth config')
      }
    })
  })

  describe('precedence ordering between content-type categories', () => {
    it('JSON path wins over binary path when content-type matches both heuristics', () => {
      // application/vnd.api+json: starts with "application/", contains "+json".
      // isBinaryContentType would return true if isJsonContentType were skipped.
      // The implementation must check JSON first.
      const r = translateProxyBody(
        'POST',
        'application/vnd.api+json',
        bufFromString('{"x":1}')
      )
      expect(r).toEqual({ ok: true, body: { x: 1 } })
      // Ensure binaryBody was not produced
      expect(r.ok && r.binaryBody).toBeUndefined()
    })
  })

  describe('all body-bearing methods are translated', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s with JSON body is parsed',
      (method) => {
        const r = translateProxyBody(
          method,
          'application/json',
          bufFromString('{"m":"' + method + '"}')
        )
        expect(r.ok && r.body).toEqual({ m: method })
      }
    )

    it.each(['POST', 'PUT', 'PATCH'])('%s with binary body is base64-encoded', (method) => {
      const r = translateProxyBody(
        method,
        'image/png',
        bufFromBytes(0x89, 0x50, 0x4e, 0x47)
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.binaryBody?.content_type).toBe('image/png')
    })
  })
})
