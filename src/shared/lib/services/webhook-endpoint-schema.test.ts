import { describe, it, expect } from 'vitest'
import {
  verificationProfileSchema,
  webhookEndpointSchema,
  webhookEnvelopeSchema,
  extractEndpointUrl,
} from './webhook-endpoint-schema'

describe('verificationProfileSchema', () => {
  const base = {
    algorithm: 'hmac-sha256',
    encoding: 'hex',
    header: 'x-hub-signature-256',
    template: '{body}',
    secret: 's3cret',
  }

  it('accepts a minimal profile', () => {
    expect(verificationProfileSchema.safeParse(base).success).toBe(true)
  })

  it('accepts all optional knobs', () => {
    expect(
      verificationProfileSchema.safeParse({
        ...base,
        prefix: 'sha256=',
        timestamp_header: 'x-ts',
        webhook_id_header: 'webhook-id',
        tolerance_secs: 600,
        secret_encoding: 'base64',
      }).success,
    ).toBe(true)
  })

  it('is strict: rejects unknown knobs (outbound writes must be exact)', () => {
    expect(verificationProfileSchema.safeParse({ ...base, sorted_params: true }).success).toBe(false)
  })

  it('rejects a template without {body}', () => {
    expect(verificationProfileSchema.safeParse({ ...base, template: '{timestamp}' }).success).toBe(false)
  })

  it('rejects unsupported algorithms', () => {
    expect(verificationProfileSchema.safeParse({ ...base, algorithm: 'ecdsa-p256' }).success).toBe(false)
  })

  it('rejects base64-encoded secrets that atob cannot decode', () => {
    // length % 4 === 1 passes a naive base64 regex but throws in the engine's
    // decoder, which would soft-fail every delivery to verified:false.
    expect(
      verificationProfileSchema.safeParse({ ...base, secret: 'whsec_AAAAA', secret_encoding: 'base64' })
        .success
    ).toBe(false)
    expect(
      verificationProfileSchema.safeParse({ ...base, secret: 'AAA=====', secret_encoding: 'base64' })
        .success
    ).toBe(false)
    expect(
      verificationProfileSchema.safeParse({
        ...base,
        secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        secret_encoding: 'base64',
      }).success
    ).toBe(true)
  })
})

describe('webhookEndpointSchema', () => {
  it('parses a proxy response and tolerates unknown fields', () => {
    const parsed = webhookEndpointSchema.parse({
      id: 'whep_x',
      url: 'https://proxy/v1/hooks/whep_x',
      name: 'n',
      status: 'active',
      verification: { algorithm: 'hmac-sha256', has_secret: true, some_future_field: 1 },
      receive_count: 3,
      future_field: 'ignored',
    })
    expect(parsed.id).toBe('whep_x')
    expect(parsed.verification?.has_secret).toBe(true)
  })

  it('rejects a response missing the public URL', () => {
    expect(
      webhookEndpointSchema.safeParse({ id: 'whep_x', name: 'n', status: 'active' }).success,
    ).toBe(false)
  })
})

describe('webhookEnvelopeSchema', () => {
  it('parses an ingest envelope', () => {
    const parsed = webhookEnvelopeSchema.parse({
      kind: 'event',
      verified: false,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      query: {},
      content_type: 'application/json',
      body: '{}',
      body_encoding: 'utf8',
      received_at: '2026-07-06T00:00:00Z',
    })
    expect(parsed.kind).toBe('event')
    expect(parsed.verified).toBe(false)
  })

  it('is lenient about envelope evolution but requires kind/verified', () => {
    expect(
      webhookEnvelopeSchema.safeParse({ kind: 'event', verified: true, new_field: 1 }).success,
    ).toBe(true)
    expect(webhookEnvelopeSchema.safeParse({ method: 'POST' }).success).toBe(false)
  })
})

describe('extractEndpointUrl', () => {
  it('reads the mirrored public URL', () => {
    expect(extractEndpointUrl(JSON.stringify({ url: 'https://p/v1/hooks/whep_1', endpointId: 'whep_1' })))
      .toBe('https://p/v1/hooks/whep_1')
  })

  it('returns null for missing/corrupt config', () => {
    expect(extractEndpointUrl(null)).toBeNull()
    expect(extractEndpointUrl('not json')).toBeNull()
    expect(extractEndpointUrl(JSON.stringify({ other: 1 }))).toBeNull()
  })
})
