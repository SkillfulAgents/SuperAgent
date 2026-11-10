/**
 * A directory's credentials at rest: AES-256-GCM under a key derived from the
 * deployment's auth secret (as S3 volume credentials are), bound to the
 * provider and workspace they were verified for, so a row edited to name
 * another workspace no longer opens.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'

const sealedSchema = z.object({ v: z.literal(1), sealed: z.string().min(1) })

const key = async () => Buffer.from(hkdfSync('sha256', await getOrCreateAuthSecret(), 'gamut-team-directory', 'credentials-v1', 32))
const context = (provider: string, tenantId: string) => Buffer.from(JSON.stringify([provider, tenantId]))

export class DirectoryCredentialsUnavailableError extends Error {
  constructor() {
    super('The saved directory credentials could not be unlocked. Connect the directory again.')
    this.name = 'DirectoryCredentialsUnavailableError'
  }
}

export async function sealDirectoryCredentials(provider: string, tenantId: string, credentials: unknown): Promise<string> {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', await key(), iv)
  cipher.setAAD(context(provider, tenantId))
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()])
  return JSON.stringify(sealedSchema.parse({ v: 1, sealed: Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') }))
}

/** The stored JSON, unparsed: the provider's own schema validates it. */
export async function openDirectoryCredentials(provider: string, tenantId: string, stored: string): Promise<unknown> {
  // Outside the try: a failure to read the secret is not a key that fails to unlock.
  const secretKey = await key()
  try {
    const encrypted = Buffer.from(sealedSchema.parse(JSON.parse(stored)).sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', secretKey, encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    decipher.setAAD(context(provider, tenantId))
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString())
  } catch {
    throw new DirectoryCredentialsUnavailableError()
  }
}
