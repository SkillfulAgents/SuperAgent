import { z } from 'zod'

const endpoint = z.string().trim().default('').refine(value => {
  if (!value) return true
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch { return false }
}, 'Use an S3 endpoint URL without a bucket, path, query, or credentials')

export const s3CredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1, 'Enter an access key ID').max(256),
  secretAccessKey: z.string().min(1, 'Enter a secret access key').max(1024),
  sessionToken: z.string().max(16384).optional(),
}).strict()

const location = z.object({
  endpoint,
  region: z.string().trim().min(1, 'Enter the bucket region').max(100).default('us-east-1'),
  bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'Enter a bucket name, not a URL'),
  prefix: z.string().max(900).default('').transform(value => value.replace(/^\/+|\/+$/g, ''))
    .refine(value => !value || value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\') && ![...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)), 'Use a folder prefix without dot segments or empty path segments'),
  forcePathStyle: z.boolean().default(true),
})
export const s3InputConfigSchema = location.extend({ credentials: s3CredentialsSchema }).strict()
export const s3StoredConfigSchema = location.extend({ credentials: z.object({ sealed: z.string().base64().min(40) }).strict() }).strict()
/** Input is sealed by prepareS3Volume before the database boundary. */
export const s3VolumeConfigSchema = z.union([s3InputConfigSchema, s3StoredConfigSchema])
export type S3InputConfig = z.infer<typeof s3InputConfigSchema>
export type S3StoredConfig = z.infer<typeof s3StoredConfigSchema>
export type S3VolumeConfig = z.infer<typeof s3VolumeConfigSchema>
export type S3Credentials = z.infer<typeof s3CredentialsSchema>
