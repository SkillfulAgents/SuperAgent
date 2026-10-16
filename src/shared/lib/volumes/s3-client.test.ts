import { afterEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { s3Fixture } from './testing/s3-fixture'
import { S3VolumeClient, s3Error, sealedS3Keys } from './s3-client'
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const reply = (code: string, statusCode: number, headers = {}) => ({ response: { statusCode, headers, body: Readable.from([`<Error><Code>${code}</Code></Error>`]) } })

describe('S3 signed transport', () => {
  it('uses explicit credentials, endpoint, region and path-style addressing', async () => {
    const f = s3Fixture(); f.put('file', Buffer.from('file'))
    await f.volume().stat('file')
    const request = f.requests[0]
    expect(request.headers.authorization).toContain('Credential=test-access-key/')
    expect(request.headers.authorization).toContain('/us-east-1/s3/aws4_request')
    expect(request.headers.authorization).not.toContain('test-secret-key')
    expect(request.headers.host).toBe(new URL(f.config.endpoint).host)
    expect(request.key).toBe('mounted/file')
  })
  it('shares mutation and throttle scope across equivalent endpoint spellings', () => {
    const f = s3Fixture()
    const first = new S3VolumeClient(f.config, sealedS3Keys(f.config))
    const respelled = { ...f.config, endpoint: `${f.config.endpoint.toUpperCase()}:443/` }
    const second = new S3VolumeClient(respelled, sealedS3Keys(respelled))
    expect(second.namespace).toBe(first.namespace)
  })
  it('retries an uncertain read but never an uncertain published write', async () => {
    const f = s3Fixture(); f.put('file', Buffer.from('file'))
    const client = new S3VolumeClient(f.config, sealedS3Keys(f.config))
    f.transport.mockResolvedValueOnce(reply('ServiceUnavailable', 503))
    const response = await client.send(new GetObjectCommand({ Bucket: f.config.bucket, Key: 'mounted/file' }), { read: true })
    expect(Buffer.from(await response.Body!.transformToByteArray()).toString()).toBe('file')
    expect(f.transport).toHaveBeenCalledTimes(2)
    f.transport.mockClear(); f.transport.mockResolvedValueOnce(reply('ServiceUnavailable', 503))
    await expect(client.send(new PutObjectCommand({ Bucket: f.config.bucket, Key: 'mounted/file', Body: Buffer.from('new') }))).rejects.toMatchObject({ status: 503 })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.bytes('file')).toEqual(Buffer.from('file'))
  })
  it('honors long Retry-After, returns 429, and shares cooldown across clients', async () => {
    const f = s3Fixture()
    f.transport.mockResolvedValueOnce(reply('SlowDown', 503, { 'retry-after': '60' }))
    const first = new S3VolumeClient(f.config, sealedS3Keys(f.config)), second = new S3VolumeClient(f.config, sealedS3Keys(f.config))
    const command = () => new GetObjectCommand({ Bucket: f.config.bucket, Key: 'mounted/file' })
    await expect(first.send(command(), { read: true })).rejects.toMatchObject({ status: 429, retryAfter: 60 })
    await expect(second.send(command(), { read: true })).rejects.toMatchObject({ status: 429 })
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('aborts requests before sending credentials or content', async () => {
    const f = s3Fixture(), client = new S3VolumeClient(f.config, sealedS3Keys(f.config))
    const signal = new AbortController(); signal.abort()
    await expect(client.send(new PutObjectCommand({ Bucket: f.config.bucket, Key: 'mounted/file', Body: Buffer.from('x') }), { signal: signal.signal })).rejects.toMatchObject({ status: 409 })
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('maps provider failures without exposing signed requests or secrets', () => {
    expect(s3Error({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }).message).toContain('Bucket not found')
    expect(s3Error({ name: 'AuthorizationHeaderMalformed' }).message).toContain('region')
    expect(s3Error({ name: 'Unknown', message: 'secret-signature' }).message).not.toContain('secret-signature')
    expect(s3Error({ name: 'PreconditionFailed' })).toMatchObject({ status: 409 })
  })
})
