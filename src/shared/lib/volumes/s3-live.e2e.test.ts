/** Opt-in against a disposable bucket/prefix. Credentials come only from a local
 * mode-0600 JSON file shaped like s3InputConfigSchema; never commit it.
 * S3_TEST_CONFIG=/path/to/config.json S3_TEST_IMAGE=<existing-agent-image> \
 *   npx vitest run src/shared/lib/volumes/s3-live.e2e.test.ts 2>&1 | tee /tmp/s3-live-e2e.txt
 */
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { AbortMultipartUploadCommand, DeleteObjectsCommand, GetObjectCommand, ListMultipartUploadsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { s3InputConfigSchema, type S3InputConfig } from './s3-schema'
import { S3MountableVolume, S3_PART_BYTES } from './s3-mountable-volume'
import { S3VolumeClient } from './s3-client'
import { validateS3Volume } from './s3-validation'

let volume: S3MountableVolume
vi.mock('@shared/lib/services/mount-service', () => ({ resolveVolume: async (agent: string, id: string) => agent === 's3-test' && id === 's3-test' ? { ops: volume, readOnly: false } : null }))
vi.mock('../../../api/middleware/auth', () => ({ IsAgent: (): MiddlewareHandler => async (c, next) => {
  if (c.req.header('Authorization') !== 'Bearer s3-live-test') return c.body(null, 401)
  c.set('agentSlug' as never, 's3-test' as never); return next()
} }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
import routes from '../../../api/routes/volumes'

const enabled = !!process.env.S3_TEST_CONFIG
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const docker = async (...args: string[]) => (await promisify(execFile)('docker', args, { timeout: 90_000, maxBuffer: 1024 * 1024 })).stdout.trim()
const bytes = (text: string) => new Blob([text]).stream()
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    if (await check().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('The mounted changes did not reach S3 within 60 seconds')
}

describe.skipIf(!enabled)('live S3 bucket and mounted filesystem', () => {
  let config: S3InputConfig, client: S3VolumeClient
  let server: ServerType | undefined
  let container: string | undefined
  beforeAll(() => {
    const input = s3InputConfigSchema.parse(JSON.parse(readFileSync(process.env.S3_TEST_CONFIG!, 'utf8')))
    if (!input.prefix) throw new Error('Live testing requires an explicit test prefix')
    config = { ...input, prefix: `${input.prefix}/run-${randomUUID()}` }
    client = new S3VolumeClient(config)
    volume = new S3MountableVolume(randomUUID(), 'S3 Test', config)
    console.log('Live S3 test prefix:', config.prefix)
  })
  afterAll(async () => {
    if (container) await docker('rm', '-f', container).catch(() => {})
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    if (!config) return
    const Prefix = `${config.prefix}/`
    // Clean only this run's randomly generated prefix, including partial failures.
    const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix }), { read: true })
    for (const upload of uploads.Uploads ?? []) {
      if (!upload.Key?.startsWith(Prefix) || !upload.UploadId) throw new Error('Unexpected upload outside the test prefix')
      await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: upload.Key, UploadId: upload.UploadId }))
    }
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix }), { read: true })
      if (!page.Contents?.length) break
      if (page.Contents.some(object => !object.Key?.startsWith(Prefix))) throw new Error('Unexpected object outside the test prefix')
      const removed = await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: page.Contents.map(object => ({ Key: object.Key! })) } }))
      expect(removed.Errors ?? []).toEqual([])
    }
    const remaining = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix, MaxKeys: 1 }), { read: true })
    expect(remaining.Contents ?? []).toEqual([])
    console.log('Cleaned this run’s test objects and incomplete uploads.')
  }, 90_000)

  it('validates read/write/copy/delete and multipart privileges', async () => {
    const result = await validateS3Volume(config)
    expect(result).toMatchObject({ valid: true, warnings: [] })
  }, 60_000)

  it.each([0, 512 * 1024, S3_PART_BYTES, S3_PART_BYTES + 1, 32 * 1024 * 1024])('round-trips %i bytes, verified by a direct S3 read', async size => {
    const input = Uint8Array.from({ length: size }, (_, i) => i % 251)
    const name = `size-${size}.bin`
    await volume.write(name, new Blob([input]).stream())
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${name}` }), { read: true })
    expect(hash(await response.Body!.transformToByteArray())).toBe(hash(input))
    expect((await volume.stat(name)).size).toBe(size)
  }, 60_000)

  it('preserves external edits and supports nested folder renames', async () => {
    await volume.mkdir('nested'); await volume.mkdir('nested/empty')
    await volume.write('nested/café & + # %.txt', bytes('original'))
    await volume.move('nested', 'renamed')
    expect((await volume.list('renamed')).map(entry => entry.name).sort()).toEqual(['café & + # %.txt', 'empty'])
    const name = 'renamed/café & + # %.txt'
    const opened = await volume.read(name)
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${name}`, Body: Buffer.from('external') }))
    await expect(opened.stream()).rejects.toMatchObject({ status: 409 })
    expect((await volume.stat(name)).size).toBe(8)
  }, 60_000)

  it('publishes 24 concurrent files without serializing unrelated paths', async () => {
    await volume.mkdir('batch')
    const start = performance.now()
    await Promise.all(Array.from({ length: 24 }, (_, i) => volume.write(`batch/file-${i}`, bytes(`file-${i}`))))
    expect((await volume.list('batch')).length).toBe(24)
    console.log(`24 parallel writes: ${Math.round(performance.now() - start)}ms`)
  }, 60_000)

  it.skipIf(!process.env.S3_TEST_IMAGE)('round-trips files through the actual rclone mount2 filesystem and WebDAV route', async () => {
    const app = new Hono().route('/api/volumes', routes)
    server = serve({ fetch: app.fetch, port: 0, hostname: '0.0.0.0' })
    await new Promise<void>(resolve => server!.listening ? resolve() : server!.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    container = `gamut-s3-test-${randomUUID().slice(0, 8)}`
    await docker('run', '-d', '--name', container, '--cap-add', 'SYS_ADMIN', '--device', '/dev/fuse', '--security-opt', 'apparmor:unconfined', '--add-host', 'host.docker.internal:host-gateway', '--user', 'root', '--entrypoint', 'bash', process.env.S3_TEST_IMAGE!, '-lc',
      `mkdir -p /tmp/s3-mount && exec rclone mount2 :webdav: /tmp/s3-mount --webdav-url http://host.docker.internal:${port}/api/volumes/s3-test/ --webdav-bearer-token s3-live-test --webdav-vendor rclone --vfs-cache-mode full --vfs-write-back 1s --dir-cache-time 5m --attr-timeout 0s --vfs-handle-caching 0 --cache-dir /tmp/s3-cache --log-level INFO`)
    const shell = (script: string) => docker('exec', container!, 'bash', '-lc', script)
    await waitFor(async () => (await shell('mountpoint /tmp/s3-mount')).includes('is a mountpoint'))
    await shell(`python3 - <<'PY'
from pathlib import Path
import os
p=Path('/tmp/s3-mount/fuse')
p.mkdir()
(p/'empty').mkdir()
(p/'unicode café.txt').write_text('hello from mounted S3')
(p/'index').write_text('before')
(p/'index.lock').write_text('after')
os.replace(p/'index.lock',p/'index')
(p/'large.bin').write_bytes(bytes(range(256)) * (65536+1))
for i in range(12): (p/f'batch-{i}').write_text(str(i))
assert (p/'index').read_text() == 'after'
assert (p/'large.bin').stat().st_size == 256*(65536+1)
print('FUSE writes, reads, rename-overwrite, and large file succeeded')
PY`)
    await waitFor(async () => {
      const read = async (name: string) => {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/fuse/${name}` }), { read: true })
        return result.Body!.transformToByteArray()
      }
      return Buffer.from(await read('index')).toString() === 'after' && (await read('large.bin')).length === 256 * 65537 && Buffer.from(await read('batch-11')).toString() === '11'
    })
    expect(await shell('cat "/tmp/s3-mount/fuse/unicode café.txt"')).toBe('hello from mounted S3')
    await shell('mv /tmp/s3-mount/fuse /tmp/s3-mount/fuse-renamed')
    await waitFor(async () => (await volume.stat('fuse-renamed/index')).size === 5)
    console.log('Verified mounted writes in R2 independently of the VFS cache.')
  }, 180_000)
})
