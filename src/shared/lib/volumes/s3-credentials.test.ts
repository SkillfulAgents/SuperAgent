import { createDecipheriv, hkdfSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { s3InputConfigSchema } from './s3-schema'
import { openS3Credentials, sealS3Config } from './s3-credentials'
const SECRET = 'a-stable-deployment-secret-for-tests-only'
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'a-stable-deployment-secret-for-tests-only' }))
const config = s3InputConfigSchema.parse({ endpoint: 'https://s3.example', bucket: 'bucket', region: 'auto', prefix: 'team', credentials: { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret-value', sessionToken: 'test-session-token' } })

describe('S3 stored credentials', () => {
  it('round-trips encrypted credentials without storing any plaintext credential', async () => {
    const saved = await sealS3Config(config)
    for (const value of Object.values(config.credentials)) expect(JSON.stringify(saved)).not.toContain(value)
    expect(await openS3Credentials(saved)).toEqual(config.credentials)
    expect((await sealS3Config(config)).credentials.sealed).not.toBe(saved.credentials.sealed)
  })
  it('seals under the key derived from the auth secret as it always was, so saved volumes still open', async () => {
    // HKDF-SHA256(auth secret, salt 'gamut-volume-credentials', info 's3-v1', 32 bytes): any
    // change here would lock every volume sealed before it.
    const key = Buffer.from(hkdfSync('sha256', SECRET, 'gamut-volume-credentials', 's3-v1', 32))
    const encrypted = Buffer.from((await sealS3Config(config)).credentials.sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    decipher.setAAD(Buffer.from(JSON.stringify([config.endpoint, config.region, config.bucket, config.prefix, config.forcePathStyle])))
    const plain = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString()
    expect(JSON.parse(plain)).toEqual(config.credentials)
  })
  it.each(['endpoint', 'bucket', 'region', 'prefix'] as const)('binds credentials to %s and refuses redirected ciphertext', async field => {
    const saved = await sealS3Config(config)
    await expect(openS3Credentials({ ...saved, [field]: 'changed' })).rejects.toThrow('could not be unlocked')
  })
  it('refuses a damaged ciphertext without disclosing it', async () => {
    const saved = await sealS3Config(config)
    const bad = { ...saved, credentials: { sealed: saved.credentials.sealed.slice(4) } }
    await expect(openS3Credentials(bad)).rejects.toThrow('could not be unlocked')
  })
})
