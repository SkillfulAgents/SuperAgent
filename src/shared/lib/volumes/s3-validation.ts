import type { VolumeValidation } from './volume-validation-schema'
import { randomUUID } from 'node:crypto'
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3'
import { S3VolumeClient, sealedS3Access } from './s3-client'
import { s3InputConfigSchema, type S3InputConfig, type S3VolumeConfig } from './s3-schema'
import { sealS3Config } from './s3-credentials'
import { VolumeError } from './volume-error'

/** Probe only disposable, uniquely named objects inside the chosen prefix. Never
 * require ListBuckets, IAM, ACL, or any access outside the mounted prefix. */
export async function validateS3Volume(raw: unknown): Promise<VolumeValidation> {
  const config = s3InputConfigSchema.parse(raw)
  const client = new S3VolumeClient(sealedS3Access(config))
  const Bucket = config.bucket
  const Prefix = config.prefix ? `${config.prefix}/` : ''
  const probe = `${Prefix}.gamut-check-${randomUUID()}`
  const Key = `${probe}/object`
  const copy = `${probe}/copy`
  const multipart = `${probe}/multipart`
  const checks: VolumeValidation['checks'] = []
  const warnings: string[] = []
  const objects = new Set<string>()
  const sessions = new Map<string, string>()
  const content = Buffer.from('Gamut S3 connection check\n')
  // One shared deadline, including retries; cleanup gets its own bounded chance.
  const signal = AbortSignal.timeout(45_000)
  const step = async (label: string, run: () => Promise<void>): Promise<boolean> => {
    try { await run(); checks.push({ label, status: 'passed' }); return true }
    catch (error) {
      checks.push({ label, status: 'failed', message: signal.aborted ? 'The connection check timed out. Check the endpoint and try again.' : error instanceof Error ? error.message : 'S3 could not complete this check.' })
      return false
    }
  }
  let etag: string | undefined
  try {
    const listed = await step('List objects', async () => {
      await client.send(new ListObjectsV2Command({ Bucket, Prefix, MaxKeys: 1 }), { read: true, signal })
    })
    const wrote = listed && await step('Create and overwrite objects', async () => {
      // Record before sending: an uncertain response can still have created the object.
      objects.add(Key)
      const created = await client.send(new PutObjectCommand({ Bucket, Key, Body: content, IfNoneMatch: '*' }), { signal })
      if (!created.ETag) throw new VolumeError('S3 did not return an object version (ETag).', 400)
      const updated = await client.send(new PutObjectCommand({ Bucket, Key, Body: content, IfMatch: created.ETag }), { signal })
      etag = updated.ETag
    })
    if (wrote) {
      await step('Read objects', async () => {
        const result = await client.send(new GetObjectCommand({ Bucket, Key, IfMatch: etag }), { read: true, signal })
        if (!Buffer.from(await result.Body!.transformToByteArray()).equals(content)) throw new VolumeError('The bucket did not return the bytes written by the connection check.', 400)
      })
      await step('Protect concurrent edits', async () => {
        try {
          await client.send(new PutObjectCommand({ Bucket, Key, Body: content, IfNoneMatch: '*' }), { signal })
        } catch (error) {
          if (!(error instanceof VolumeError && error.status === 409)) throw error
          try { await client.send(new PutObjectCommand({ Bucket, Key, Body: content, IfMatch: '"invalid-etag"' }), { signal }) }
          catch (overwriteError) { if (overwriteError instanceof VolumeError && overwriteError.status === 409) return; throw overwriteError }
        }
        throw new VolumeError('This provider ignores conditional writes. Mounting it could overwrite newer edits.', 400)
      })
      await step('Copy objects (rename)', async () => {
        objects.add(copy)
        await client.send(new CopyObjectCommand({ Bucket, Key: copy, CopySource: `${Bucket}/${Key.split('/').map(encodeURIComponent).join('/')}`, CopySourceIfMatch: etag }), { signal })
      })
      await step('Upload large files', async () => {
        const created = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: multipart }), { signal })
        if (!created.UploadId) throw new VolumeError('S3 did not start a multipart upload.', 400)
        sessions.set(multipart, created.UploadId)
        const part = await client.send(new UploadPartCommand({ Bucket, Key: multipart, UploadId: created.UploadId, PartNumber: 1, Body: content }), { signal })
        objects.add(multipart)
        await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: multipart, UploadId: created.UploadId, MultipartUpload: { Parts: [{ ETag: part.ETag, PartNumber: 1 }] }, IfNoneMatch: '*' }), { signal })
        sessions.delete(multipart)
      })
      await step('Cancel unfinished uploads', async () => {
        const created = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: multipart }), { signal })
        if (!created.UploadId) throw new VolumeError('S3 did not start a multipart upload.', 400)
        sessions.set(multipart, created.UploadId)
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key: multipart, UploadId: created.UploadId }), { signal })
        sessions.delete(multipart)
      })
    } else {
      for (const label of ['Read objects', 'Protect concurrent edits', 'Copy objects (rename)', 'Upload large files', 'Cancel unfinished uploads']) {
        checks.push({ label, status: 'skipped', message: 'Requires a successful test-object write.' })
      }
    }
  } finally {
    const cleanup = AbortSignal.timeout(10_000)
    for (const [key, UploadId] of sessions) {
      try { await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }), { signal: cleanup }) }
      catch { warnings.push(`An unfinished test upload remains at ${key}. Abort it in your storage provider’s dashboard.`) }
    }
    if (objects.size) {
      const deleted = await step('Delete objects', async () => {
        const errors: string[] = []
        for (const key of objects) {
          try { await client.send(new DeleteObjectCommand({ Bucket, Key: key }), { signal: cleanup }) }
          catch { errors.push(key) }
        }
        if (errors.length) {
          warnings.push(`Could not remove test objects: ${errors.join(', ')}. Remove them after fixing delete permissions.`)
          throw new VolumeError('This key could not delete the test objects. Grant s3:DeleteObject (R2: Object Read & Write) for this bucket and prefix.', 400)
        }
      })
      if (!deleted) warnings.push('Rename and delete will not work until delete access is available.')
    }
  }
  if (config.endpoint.startsWith('http:')) warnings.push('This endpoint uses unencrypted HTTP. Use HTTPS unless this is a trusted local S3 service.')
  return { valid: checks.every(check => check.status === 'passed') && !sessions.size, checks, warnings }
}

export async function prepareS3Volume(config: S3VolumeConfig): Promise<{ name: string; config: ReturnType<typeof sealS3Config> }> {
  // Only fresh credentials are accepted from the API. A ciphertext copied out of
  // storage must never become a credential reference a different user can submit.
  const input: S3InputConfig = s3InputConfigSchema.parse(config)
  const result = await validateS3Volume(input)
  if (!result.valid) throw new VolumeError([...result.checks.filter(check => check.status === 'failed').map(check => `${check.label}: ${check.message}`), ...result.warnings].join(' '), 400)
  return { name: input.prefix.split('/').at(-1) || input.bucket, config: sealS3Config(input) }
}
