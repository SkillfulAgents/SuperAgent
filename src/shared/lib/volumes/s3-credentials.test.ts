import { describe, expect, it, vi } from 'vitest'
import { s3InputConfigSchema } from './s3-schema'
import { openS3Credentials, sealS3Config } from './s3-credentials'
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: () => 'a-stable-deployment-secret-for-tests-only' }))
const config = s3InputConfigSchema.parse({ endpoint: 'https://s3.example', bucket: 'bucket', region: 'auto', prefix: 'team', credentials: { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret-value', sessionToken: 'test-session-token' } })

describe('S3 stored credentials', () => {
  it('round-trips encrypted credentials without storing any plaintext credential', () => {
    const saved = sealS3Config(config)
    for (const value of Object.values(config.credentials)) expect(JSON.stringify(saved)).not.toContain(value)
    expect(openS3Credentials(saved)).toEqual(config.credentials)
    expect(sealS3Config(config).credentials.sealed).not.toBe(saved.credentials.sealed)
  })
  it.each(['endpoint', 'bucket', 'region', 'prefix'] as const)('binds credentials to %s and refuses redirected ciphertext', field => {
    const saved = sealS3Config(config)
    expect(() => openS3Credentials({ ...saved, [field]: 'changed' })).toThrow('could not be unlocked')
  })
  it('refuses a damaged ciphertext without disclosing it', () => {
    const saved = sealS3Config(config)
    const bad = { ...saved, credentials: { sealed: saved.credentials.sealed.slice(4) } }
    expect(() => openS3Credentials(bad)).toThrow('could not be unlocked')
  })
})
