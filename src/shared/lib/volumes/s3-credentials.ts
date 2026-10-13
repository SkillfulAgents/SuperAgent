import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { s3CredentialsSchema, s3StoredConfigSchema, type S3Credentials, type S3InputConfig, type S3StoredConfig, type S3VolumeConfig } from './s3-schema'

const key = () => Buffer.from(hkdfSync('sha256', getOrCreateAuthSecret(), 'gamut-volume-credentials', 's3-v1', 32))
// Bind the ciphertext to its destination. Editing a stored endpoint cannot redirect keys.
const context = (config: S3VolumeConfig) => Buffer.from(JSON.stringify([config.endpoint, config.region, config.bucket, config.prefix, config.forcePathStyle]))

export function sealS3Config(config: S3InputConfig): S3StoredConfig {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(context(config))
  const data = Buffer.concat([cipher.update(JSON.stringify(s3CredentialsSchema.parse(config.credentials))), cipher.final()])
  return s3StoredConfigSchema.parse({ ...config, credentials: { sealed: Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') } })
}

export function openS3Credentials(config: S3VolumeConfig): S3Credentials {
  if ('accessKeyId' in config.credentials) return s3CredentialsSchema.parse(config.credentials)
  try {
    const encrypted = Buffer.from(config.credentials.sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key(), encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    decipher.setAAD(context(config))
    return s3CredentialsSchema.parse(JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString()))
  } catch {
    throw new WorkspaceFileError('not-accessible', 'The saved S3 credentials could not be unlocked. Restore this deployment’s auth secret or reconnect the volume.')
  }
}
