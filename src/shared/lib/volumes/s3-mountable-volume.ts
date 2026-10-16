import path from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, UploadPartCommand, UploadPartCopyCommand, type CompletedPart, type HeadObjectCommandOutput, type _Object } from '@aws-sdk/client-s3'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { writeProxyAuditEntry } from '@shared/lib/proxy/audit'
import { BaseMountableVolume, type VolumeEntry, type VolumeFile } from './base-mountable-volume'
import { S3VolumeClient } from './s3-client'
import type { S3VolumeConfig } from './s3-schema'
import { RemoteListingCache } from './remote-listing-cache'
import { RemoteHealthCache } from './remote-health-cache'
import { rangedVolumeFile } from './remote-file'
import { throwIfUploadAborted, uploadChunks } from './remote-transfer'
import { volumeUploads } from './volume-upload-guard'
import { VolumeError } from './volume-error'

export const S3_PART_BYTES = 8 * 1024 * 1024
const COPY_PART_BYTES = 128 * 1024 * 1024
// A git clone or npm install makes thousands of folders; the shared default of 256 evicts them mid-run.
const listings = new RemoteListingCache<VolumeEntry>(undefined, { maxDirectories: 4096, maxEntries: 50_000 })
const health = new RemoteHealthCache()
const directory = (name: string): VolumeEntry => ({ name, kind: 'directory', size: 0, mtimeMs: 0 })
const filename = (key: string) => key.split('/').at(-1) ?? ''
const parentOf = (relative: string) => { const parent = path.posix.dirname(relative); return parent === '.' ? '' : parent }
const representable = (name: string) => !!name && name !== '.' && name !== '..' && !/[\\/]/.test(name) && ![...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
const missing = (error: unknown) => error instanceof WorkspaceFileError && error.code === 'not-found'
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('base64')

// Siblings can publish concurrently. A folder delete/rename claims its subtree,
// so it waits for earlier child writes, and later child writes wait for it.
const mutations = new Map<string, { paths: string[]; done: Promise<unknown> }[]>()
function mutate<T>(namespace: string, paths: string[], operation: () => Promise<T>): Promise<T> {
  const pending = mutations.get(namespace) ?? []
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  const before = pending.filter(item => item.paths.some(a => paths.some(b => overlaps(a, b))))
  const item = { paths, done: Promise.all(before.map(item => item.done.catch(() => {}))).then(operation) }
  mutations.set(namespace, [...pending, item])
  return item.done.finally(() => {
    const remaining = mutations.get(namespace)!.filter(other => other !== item)
    if (remaining.length) mutations.set(namespace, remaining)
    else mutations.delete(namespace)
  })
}

/** S3 directories are prefixes; a zero-byte trailing-slash object preserves an
 * empty directory. Reads use fresh ETags, writes use conditional publication.
 * Credentials and direct S3 traffic stay on the host. */
export class S3MountableVolume extends BaseMountableVolume<S3VolumeConfig> {
  readonly type = 's3'
  readonly cacheMode = 'remote'
  private readonly client: S3VolumeClient
  constructor(id: string, name: string, config: S3VolumeConfig, private readonly agentSlug?: string) {
    super(id, name, config)
    this.client = new S3VolumeClient(config)
  }
  get sourceLabel(): string { return `S3 · ${this.config.bucket}${this.config.prefix ? `/${this.config.prefix}` : ''}` }
  private get Bucket(): string { return this.config.bucket }
  private key(relative: string, mutate = false): string {
    if ((mutate && !relative) || (relative && relative.split('/').some(part => !representable(part)))) throw new WorkspaceFileError('invalid-path')
    const key = `${this.config.prefix ? `${this.config.prefix}/` : ''}${relative}`
    if (Buffer.byteLength(key) > 1024) throw new WorkspaceFileError('invalid-path', 'S3 object keys cannot exceed 1,024 bytes')
    return key
  }
  private prefix(relative: string): string { return relative ? `${this.key(relative)}/` : this.key('') }
  private cacheKey(relative: string): string { return JSON.stringify([this.client.cacheKey, this.key(relative)]) }
  private uploadKey(relative: string): string { return JSON.stringify(['s3', this.id, this.key(relative)]) }
  private async head(key: string): Promise<HeadObjectCommandOutput | null> {
    try { return await this.client.send(new HeadObjectCommand({ Bucket: this.Bucket, Key: key }), { read: true }) }
    catch (error) { if (missing(error)) return null; throw error }
  }
  private async* pages(Prefix: string, Delimiter?: string): AsyncGenerator<{ objects: _Object[]; prefixes: string[] }> {
    let ContinuationToken: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.Bucket, Prefix, Delimiter, ContinuationToken, MaxKeys: 1000 }), { read: true })
      yield { objects: page.Contents ?? [], prefixes: (page.CommonPrefixes ?? []).flatMap(item => item.Prefix ? [item.Prefix] : []) }
      if (!page.IsTruncated) break
      if (!page.NextContinuationToken || seen.has(page.NextContinuationToken)) throw new VolumeError('S3 returned an invalid listing cursor.', 503)
      ContinuationToken = page.NextContinuationToken
      seen.add(ContinuationToken)
    } while (true)
  }
  private async directoryExists(relative: string): Promise<boolean> {
    const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.Bucket, Prefix: this.prefix(relative), MaxKeys: 1 }), { read: true })
    return !relative || !!page.Contents?.length
  }
  private async freshStat(relative: string): Promise<VolumeEntry> {
    this.key(relative)
    if (!relative) { await this.directoryExists(''); return directory('') }
    const file = await this.head(this.key(relative))
    if (file) return { name: filename(relative), kind: 'file', size: file.ContentLength ?? 0, mtimeMs: file.LastModified?.getTime() ?? 0 }
    if (await this.directoryExists(relative)) return directory(filename(relative))
    throw new WorkspaceFileError('not-found')
  }
  /** True when a fresh listing of the parent shows nothing at this path. Same staleness as `list`. */
  private knownAbsent(relative: string): boolean {
    return !!relative && listings.cached(this.cacheKey(parentOf(relative)))?.some(entry => entry.name === filename(relative)) === false
  }
  async stat(relative: string): Promise<VolumeEntry> {
    this.client.authorize()
    if (this.knownAbsent(relative)) throw new WorkspaceFileError('not-found')
    const cached = listings.cached(this.cacheKey(parentOf(relative)))?.find(entry => entry.name === filename(relative))
    if (relative && cached?.kind === 'directory') return cached
    // File sizes stay fresh after an external edit, as for every source.
    return this.freshStat(relative)
  }
  override async health(): Promise<VolumeEntry> {
    this.client.authorize()
    return health.check(this.client.cacheKey, this.config.prefix, 0, () => this.freshStat(''))
  }
  private async listFresh(relative: string): Promise<VolumeEntry[]> {
    const Prefix = this.prefix(relative)
    const entries = new Map<string, VolumeEntry>()
    let exists = !relative
    for await (const page of this.pages(Prefix, '/')) {
      for (const prefix of page.prefixes) {
        if (!prefix.startsWith(Prefix)) throw new VolumeError('S3 returned a folder outside the requested prefix.', 503)
        const name = prefix.slice(Prefix.length).replace(/\/$/, '')
        if (representable(name)) { entries.set(name, directory(name)); exists = true }
      }
      for (const object of page.objects) {
        if (!object.Key?.startsWith(Prefix)) throw new VolumeError('S3 returned an object outside the requested prefix.', 503)
        exists = true
        if (object.Key === Prefix) {
          if (object.Size) throw new WorkspaceFileError('not-accessible', 'This folder marker contains data and cannot be treated as an empty folder.')
          continue
        }
        const name = object.Key.slice(Prefix.length)
        if (representable(name) && entries.get(name)?.kind !== 'directory') entries.set(name, { name, kind: 'file', size: object.Size ?? 0, mtimeMs: object.LastModified?.getTime() ?? 0 })
      }
    }
    if (!exists) {
      if (await this.head(this.key(relative))) throw new WorkspaceFileError('not-a-directory')
      throw new WorkspaceFileError('not-found')
    }
    return [...entries.values()]
  }
  async list(relative: string): Promise<VolumeEntry[]> {
    this.key(relative)
    this.client.authorize()
    return listings.list(this.client.namespace, this.cacheKey(relative), () => this.listFresh(relative))
  }
  async read(relative: string): Promise<VolumeFile> {
    if (!relative) throw new WorkspaceFileError('not-a-file')
    const key = this.key(relative)
    const object = await this.head(key)
    if (!object) { if (await this.directoryExists(relative)) throw new WorkspaceFileError('not-a-file'); throw new WorkspaceFileError('not-found') }
    if (!object.ETag || object.ContentLength === undefined) throw new VolumeError('S3 returned incomplete file metadata.', 503)
    return rangedVolumeFile(object.ContentLength, async ({ start, end }) => {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.Bucket, Key: key, IfMatch: object.ETag, Range: `bytes=${start}-${end}` }), { read: true })
      if (!response.Body) throw new VolumeError('S3 returned no file content.', 503)
      return new Response(response.Body.transformToWebStream(), { status: response.ContentRange ? 206 : 200, headers: response.ContentRange ? { 'Content-Range': response.ContentRange } : {} })
    })
  }
  private async parent(relative: string): Promise<void> {
    if ((await this.freshStat(parentOf(relative))).kind !== 'directory') throw new WorkspaceFileError('not-a-directory')
  }
  private async existingFile(relative: string): Promise<HeadObjectCommandOutput | null> {
    const file = await this.head(this.key(relative))
    if (await this.directoryExists(relative)) throw new WorkspaceFileError('not-a-file')
    if (file && !file.ETag) throw new VolumeError('S3 returned no object version (ETag).', 503)
    return file
  }
  /** `keep` spares this mount's own parent listings, which the change then settles in place. */
  private invalidate(paths: string[], keep: Set<string> = new Set()): void {
    // All overlapping mounts, even with different credentials, see a mutation.
    listings.forgetWhere(this.client.namespace, key => {
      if (keep.has(key)) return false
      // These keys are created by cacheKey, never provider data.
      let remote: string
      try { remote = z.tuple([z.string(), z.string()]).parse(JSON.parse(key))[1] } catch { return true }
      return paths.some(relative => {
        const changed = this.key(relative)
        return remote === changed || remote.startsWith(`${changed}/`) || remote === this.key(parentOf(relative))
      })
    })
    health.invalidate(this.client.cacheKey)
  }
  /** Runs a change. On success, `settled` names each changed path's new entry (null when removed): this
   * mount's warm parent listings take it in place instead of being read again. A failure drops them,
   * since its outcome in S3 may be unknown. */
  private async change<T>(paths: string[], operation: () => Promise<T>, settled?: () => [string, VolumeEntry | null][]): Promise<T> {
    return mutate(this.client.namespace, paths.map(relative => this.key(relative)), async () => {
      this.client.authorize()
      const keep = new Set(settled ? paths.map(relative => this.cacheKey(parentOf(relative))) : [])
      this.invalidate(paths, keep)
      let ok = false
      try { const result = await operation(); ok = true; return result } finally {
        this.invalidate(paths, ok ? keep : new Set())
        if (ok && settled) for (const [relative, entry] of settled()) {
          const key = this.cacheKey(parentOf(relative))
          const listing = listings.recent(key, Infinity)
          // With no listing to update, a read still in flight began before this change: detach it.
          if (listing) listings.put(this.client.namespace, key, [...listing.entries.filter(item => item.name !== filename(relative)), ...(entry ? [entry] : [])], listing.readAt, listing.checkedAt)
          else listings.forget(key)
          if (entry?.kind === 'directory') listings.seed(this.client.namespace, this.cacheKey(relative), [], Date.now())
        }
      }
    })
  }
  private async audit<T>(operation: string, relative: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now()
    let statusCode = 200
    try { return await run() } catch (error) { statusCode = error instanceof VolumeError || error instanceof WorkspaceFileError ? error.status : 503; throw error }
    finally {
      if (this.agentSlug) await writeProxyAuditEntry({ agentSlug: this.agentSlug, accountId: `s3:${this.id}`, toolkit: 's3', targetHost: this.client.host, targetPath: `${this.Bucket}/${this.key(relative)}`, method: operation, statusCode, durationMs: Date.now() - started, policyDecision: 'allow' }, { analytics: false })
    }
  }
  async write(relative: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    this.key(relative, true)
    return volumeUploads.write(this.uploadKey(relative), body, signal, () => this.audit('PUT', relative, async () => {
      const Key = this.key(relative)
      // A baseline only: the check just before publishing is always fresh.
      const previous = this.knownAbsent(relative) ? null : await this.existingFile(relative)
      const chunks = uploadChunks(body, S3_PART_BYTES, signal)
      let UploadId: string | undefined
      try {
        const first = await chunks.next()
        let next = await chunks.next()
        const parts: CompletedPart[] = []
        let size = first.value?.byteLength ?? 0
        if (!next.done) {
          const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.Bucket, Key }), { signal })
          UploadId = created.UploadId
          if (!UploadId) throw new VolumeError('S3 did not start the upload.', 503)
          const upload = async (data: ArrayBuffer) => {
            if (parts.length === 10_000) throw new VolumeError('This file exceeds the multipart upload limit.', 400)
            const PartNumber = parts.length + 1
            const bytes = new Uint8Array(data)
            const result = await this.client.send(new UploadPartCommand({ Bucket: this.Bucket, Key, UploadId, PartNumber, Body: bytes, ContentMD5: md5(bytes) }), { signal })
            if (!result.ETag) throw new VolumeError('S3 did not acknowledge an upload part.', 503)
            parts.push({ ETag: result.ETag, PartNumber })
          }
          await upload(first.value!)
          do { size += next.value.byteLength; await upload(next.value); next = await chunks.next() } while (!next.done)
        }
        await this.change([relative], async () => {
          throwIfUploadAborted(signal)
          await this.parent(relative)
          const current = await this.existingFile(relative)
          if (current?.ETag !== previous?.ETag) throw new VolumeError('This file changed while it was uploading. Refresh and try again.', 409)
          throwIfUploadAborted(signal)
          const condition = previous ? { IfMatch: previous.ETag } : { IfNoneMatch: '*' }
          const bytes = new Uint8Array(first.value ?? new ArrayBuffer(0))
          const stored = UploadId
            ? await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.Bucket, Key, UploadId, MultipartUpload: { Parts: parts }, ...condition }), { signal })
            : await this.client.send(new PutObjectCommand({ Bucket: this.Bucket, Key, Body: bytes, ContentMD5: md5(bytes), ...condition }), { signal })
          UploadId = undefined
          if (signal?.aborted && !previous && stored.ETag) {
            // Only remove the revision we just created, never an external edit.
            await this.client.send(new DeleteObjectCommand({ Bucket: this.Bucket, Key, IfMatch: stored.ETag }))
          }
          throwIfUploadAborted(signal)
        }, () => [[relative, { name: filename(relative), kind: 'file', size, mtimeMs: Date.now() }]])
      } finally {
        await chunks.return(undefined)
        if (UploadId) {
          try { await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.Bucket, Key, UploadId }), { signal: AbortSignal.timeout(10_000) }) }
          catch { console.warn('[volumes] S3 multipart cleanup failed; configure a bucket lifecycle rule to expire unfinished uploads.') }
        }
      }
    }))
  }
  async mkdir(relative: string): Promise<void> {
    const Key = `${this.key(relative, true)}/`
    await this.audit('MKCOL', relative, () => this.change([relative], async () => {
      await this.parent(relative)
      const current = await this.freshStat(relative).catch(error => { if (missing(error)) return null; throw error })
      if (current) throw new WorkspaceFileError('already-exists')
      await this.client.send(new PutObjectCommand({ Bucket: this.Bucket, Key, Body: new Uint8Array(), IfNoneMatch: '*' }))
    }, () => [[relative, directory(filename(relative))]]))
  }
  private async preserveParent(relative: string): Promise<void> {
    const parent = path.posix.dirname(relative)
    if (parent === '.') return
    // Without a marker, removing the last child would remove its directory too.
    try { await this.client.send(new PutObjectCommand({ Bucket: this.Bucket, Key: `${this.key(parent)}/`, Body: new Uint8Array(), IfNoneMatch: '*' })) }
    catch (error) { if (!(error instanceof VolumeError && error.status === 409)) throw error }
  }
  private async requireEmptyDirectory(relative: string): Promise<void> {
    const Prefix = this.prefix(relative)
    const listing = await this.client.send(new ListObjectsV2Command({ Bucket: this.Bucket, Prefix, MaxKeys: 2 }), { read: true })
    if (listing.IsTruncated || listing.Contents?.some(object => object.Key !== Prefix)) throw new WorkspaceFileError('not-empty')
    if (listing.Contents?.some(object => object.Size)) throw new WorkspaceFileError('not-accessible', 'This folder marker contains data and cannot be deleted as a folder.')
  }
  async delete(relative: string): Promise<void> {
    const key = this.key(relative, true)
    volumeUploads.beforeDelete(this.uploadKey(relative))
    await this.audit('DELETE', relative, () => this.change([relative], async () => {
      const object = await this.head(key)
      if (!object) {
        if (!await this.directoryExists(relative)) throw new WorkspaceFileError('not-found')
        await this.requireEmptyDirectory(relative)
        await this.preserveParent(relative)
        await this.client.send(new DeleteObjectCommand({ Bucket: this.Bucket, Key: `${key}/` }))
      } else {
        if (await this.directoryExists(relative)) throw new WorkspaceFileError('not-accessible', 'S3 has both a file and folder at this path; resolve the collision in the bucket first.')
        if (!object.ETag) throw new WorkspaceFileError('not-found')
        await this.preserveParent(relative)
        await this.client.send(new DeleteObjectCommand({ Bucket: this.Bucket, Key: key, IfMatch: object.ETag }))
      }
    }, () => [[relative, null]]))
  }
  private async copy(source: string, target: string, object: { ETag: string; Size: number }, previous?: string): Promise<void> {
    const CopySource = `${this.Bucket}/${source.split('/').map(encodeURIComponent).join('/')}`
    const condition = previous ? { IfMatch: previous } : { IfNoneMatch: '*' }
    if (object.Size <= 5 * 1024 ** 3) {
      await this.client.send(new CopyObjectCommand({ Bucket: this.Bucket, Key: target, CopySource, CopySourceIfMatch: object.ETag, ...condition }))
      return
    }
    const { UploadId } = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.Bucket, Key: target }))
    if (!UploadId) throw new VolumeError('S3 did not start the copy.', 503)
    let completed = false
    try {
      const Parts: CompletedPart[] = []
      const partBytes = Math.max(COPY_PART_BYTES, Math.ceil(object.Size / 10_000))
      for (let start = 0; start < object.Size; start += partBytes) {
        const PartNumber = Parts.length + 1
        const result = await this.client.send(new UploadPartCopyCommand({ Bucket: this.Bucket, Key: target, UploadId, PartNumber, CopySource, CopySourceRange: `bytes=${start}-${Math.min(start + partBytes, object.Size) - 1}` }))
        Parts.push({ ETag: result.CopyPartResult?.ETag, PartNumber })
      }
      if ((await this.head(source))?.ETag !== object.ETag) throw new VolumeError('The source changed during the copy. The original was preserved.', 409)
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.Bucket, Key: target, UploadId, MultipartUpload: { Parts }, ...condition }))
      completed = true
    } finally {
      if (!completed) await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.Bucket, Key: target, UploadId })).catch(() => {})
    }
  }
  async move(from: string, to: string): Promise<void> {
    const source = this.key(from, true), target = this.key(to, true)
    await this.audit('MOVE', from, () => this.change([from, to], async () => {
      const entry = await this.freshStat(from)
      if (from === to) return
      if (entry.kind === 'directory' && to.startsWith(`${from}/`)) throw new WorkspaceFileError('invalid-path')
      await this.parent(to).catch(error => { if (missing(error)) throw new WorkspaceFileError('not-a-directory'); throw error })
      const destination = await this.freshStat(to).catch(error => { if (missing(error)) return null; throw error })
      if (destination && (destination.kind === 'directory' || entry.kind === 'directory')) throw new WorkspaceFileError('already-exists')
      const objects: { Key: string; ETag: string; Size: number }[] = []
      if (entry.kind === 'file') {
        const object = await this.existingFile(from)
        if (!object?.ETag) throw new WorkspaceFileError('not-found')
        objects.push({ Key: source, ETag: object.ETag, Size: object.ContentLength ?? 0 })
      } else {
        for await (const page of this.pages(`${source}/`)) for (const object of page.objects) {
          if (!object.Key?.startsWith(`${source}/`) || !object.ETag || object.Size === undefined) throw new VolumeError('S3 returned incomplete copy metadata.', 503)
          objects.push({ Key: object.Key, ETag: object.ETag, Size: object.Size })
        }
      }
      // Copy everything before removing anything. A partial failure leaves the
      // originals intact, though duplicate destination objects may need cleanup.
      for (const object of objects) {
        const dest = target + object.Key.slice(source.length)
        const before = await this.head(dest)
        if (entry.kind === 'directory' && before) throw new WorkspaceFileError('already-exists')
        await this.copy(object.Key, dest, object, before?.ETag)
      }
      for (const object of objects) {
        if ((await this.head(object.Key))?.ETag !== object.ETag) throw new VolumeError('A source object changed during rename. Both locations were preserved.', 409)
      }
      await this.preserveParent(from)
      for (const object of objects) await this.client.send(new DeleteObjectCommand({ Bucket: this.Bucket, Key: object.Key, IfMatch: object.ETag }))
    }))
  }
}
