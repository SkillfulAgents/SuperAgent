import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { vi } from 'vitest'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { HttpRequest } from '@smithy/types'
import * as credentials from '../s3-credentials'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { S3MountableVolume } from '../s3-mountable-volume'
import type { S3InputConfig } from '../s3-schema'
import type { VolumeContractFixture } from './volume-contract'

export interface S3TestObject { bytes: Uint8Array; etag: string }
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const decodeKey = (text: string) => { try { return decodeURIComponent(text) } catch { throw new Error('Invalid encoded S3 test key') } }
const tag = (name: string, value: string | number) => `<${name}>${escape(String(value))}</${name}>`
const bodyBytes = (input: unknown): Uint8Array => typeof input === 'string' ? Buffer.from(input) : input as Uint8Array ?? new Uint8Array()

/** Fake S3 wire service: real SDK signing, XML parsing, client pacing, and adapter. */
export function s3Fixture() {
  const id = randomUUID()
  const config: S3InputConfig = { endpoint: `https://${id}.s3.example`, bucket: 'test-bucket', region: 'us-east-1', prefix: 'mounted', forcePathStyle: true, credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' } }
  const objects = new Map<string, S3TestObject>()
  const sessions = new Map<string, { key: string; parts: Map<number, Uint8Array> }>()
  const requests: { method: string; key: string; query: NonNullable<HttpRequest['query']>; headers: Record<string, string> }[] = []
  const counts: { kind: string; path: string }[] = []
  let active = true, fail = false
  let beforeCommit = () => {}
  let deny = (_request: HttpRequest): string | undefined => undefined
  let pageSize = 1000
  const put = (key: string, bytes: Uint8Array) => {
    const object = { bytes: bytes.slice(), etag: `"${createHash('md5').update(bytes).digest('hex')}"` }
    objects.set(key, object)
    return object
  }
  vi.spyOn(credentials, 'openS3Credentials').mockImplementation(() => {
    if (!active) throw new WorkspaceFileError('not-accessible')
    return config.credentials
  })
  const transport = vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (raw) => {
    const request = raw as HttpRequest
    const key = decodeKey(request.path.slice(`/${config.bucket}/`.length))
    const query = request.query ?? {}, headers = request.headers
    requests.push({ method: request.method, key, query, headers })
    const response = (statusCode: number, body = '', headers: Record<string, string> = {}) => Promise.resolve({ response: { statusCode, headers, body: Readable.from([Buffer.from(body)]) } })
    const failure = (code: string, status = 403) => response(status, `<Error>${tag('Code', code)}</Error>`)
    const denied = deny(request)
    if (denied) return failure(denied)
    const object = objects.get(key)
    const precondition = () => headers['if-none-match'] === '*' && !!object || headers['if-match'] && headers['if-match'] !== object?.etag
    if (request.method === 'GET' && query['list-type']) {
      const prefix = String(query.prefix ?? '')
      const relative = prefix.slice('mounted/'.length).replace(/\/$/, '')
      counts.push({ kind: query['max-keys'] === '1' && !relative ? 'health' : 'list', path: relative })
      const entries = new Map<string, { kind: string; object?: S3TestObject }>()
      for (const [key, object] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!key.startsWith(prefix)) continue
        const suffix = key.slice(prefix.length)
        const delimiter = query.delimiter ? suffix.indexOf('/') : -1
        if (delimiter >= 0) entries.set(prefix + suffix.slice(0, Number(delimiter) + 1), { kind: 'prefix' })
        else entries.set(key, { kind: 'object', object })
      }
      const start = Number(query['continuation-token'] ?? 0)
      const page = [...entries].slice(start, start + Math.min(pageSize, Number(query['max-keys'] ?? 1000)))
      const end = start + page.length, more = end < entries.size
      return response(200, `<ListBucketResult>${tag('IsTruncated', String(more))}${more ? tag('NextContinuationToken', end) : ''}${page.map(([key, item]) => item.kind === 'prefix' ? `<CommonPrefixes>${tag('Prefix', key)}</CommonPrefixes>` : `<Contents>${tag('Key', key)}${tag('ETag', item.object!.etag)}${tag('Size', item.object!.bytes.length)}${tag('LastModified', '2026-10-10T00:00:00Z')}</Contents>`).join('')}</ListBucketResult>`)
    }
    if (request.method === 'HEAD') {
      return object ? response(200, '', { etag: object.etag, 'content-length': String(object.bytes.length), 'last-modified': 'Sat, 10 Oct 2026 00:00:00 GMT' }) : failure('NoSuchKey', 404)
    }
    if (request.method === 'GET') {
      if (!object) return failure('NoSuchKey', 404)
      if (precondition()) return failure('PreconditionFailed', 412)
      const range = headers.range?.slice(6).split('-').map(Number)
      const bytes = range ? object.bytes.slice(range[0], range[1] + 1) : object.bytes
      return { response: { statusCode: range ? 206 : 200, headers: { ...(range ? { 'content-range': `bytes ${range[0]}-${range[1]}/${object.bytes.length}` } : {}), 'content-length': String(bytes.length), etag: object.etag }, body: Readable.from([Buffer.from(bytes)]) } }
    }
    if (request.method === 'POST' && 'uploads' in query) {
      const uploadId = randomUUID()
      sessions.set(uploadId, { key, parts: new Map() })
      return response(200, `<InitiateMultipartUploadResult>${tag('UploadId', uploadId)}</InitiateMultipartUploadResult>`)
    }
    if (request.method === 'DELETE' && query.uploadId) { sessions.delete(String(query.uploadId)); return response(204) }
    if (request.method === 'DELETE') {
      if (precondition()) return failure('PreconditionFailed', 412)
      objects.delete(key)
      return response(204)
    }
    if (request.method === 'PUT' && headers['x-amz-copy-source']) {
      const sourceKey = decodeKey(headers['x-amz-copy-source'].slice(config.bucket.length + 1))
      const source = objects.get(sourceKey)
      if (!source) return failure('NoSuchKey', 404)
      if (headers['x-amz-copy-source-if-match'] !== source.etag || precondition()) return failure('PreconditionFailed', 412)
      const stored = put(key, source.bytes)
      return response(200, `<CopyObjectResult>${tag('ETag', stored.etag)}</CopyObjectResult>`)
    }
    if (request.method === 'PUT' && query.uploadId) {
      counts.push({ kind: 'content', path: key })
      sessions.get(String(query.uploadId))!.parts.set(Number(query.partNumber), bodyBytes(request.body))
      return response(200, '', { etag: '"part"' })
    }
    if (request.method === 'PUT' || request.method === 'POST' && query.uploadId) {
      counts.push({ kind: 'content', path: key })
      if (fail) { fail = false; return failure('ServiceUnavailable', 503) }
      if (precondition()) return failure('PreconditionFailed', 412)
      let bytes = bodyBytes(request.body)
      if (query.uploadId) {
        bytes = Buffer.concat([...sessions.get(String(query.uploadId))!.parts.values()])
        sessions.delete(String(query.uploadId))
      }
      beforeCommit(); beforeCommit = () => {}
      const stored = put(key, bytes)
      return query.uploadId ? response(200, `<CompleteMultipartUploadResult>${tag('ETag', stored.etag)}</CompleteMultipartUploadResult>`) : response(200, '', { etag: stored.etag })
    }
    throw new Error(`Unhandled mock S3 operation: ${request.method}`)
  })
  const fixture: VolumeContractFixture = {
    volume: () => new S3MountableVolume(id, 'S3', config),
    put: (path, bytes) => { put(`mounted/${path}`, bytes) },
    mkdir: path => { put(`mounted/${path}/`, new Uint8Array()) },
    bytes: path => objects.get(`mounted/${path}`)?.bytes,
    exists: path => objects.has(`mounted/${path}`) || [...objects.keys()].some(key => key.startsWith(`mounted/${path}/`)),
    failWrite: () => { fail = true }, beforeCommit: run => { beforeCommit = run }, revoke: () => { active = false },
    count: (kind, path) => counts.filter(call => call.kind === kind && (path === undefined || path === call.path)).length,
  }
  return { ...fixture, config, objects, sessions, requests, transport, putObject: put, deny: (run: typeof deny) => { deny = run }, setPageSize: (size: number) => { pageSize = size } }
}
