#!/usr/bin/env npx tsx
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { openDatabase, db, closeDatabase } from '../../../src/shared/lib/db'
import { agentVolumes, volumeDefinitions } from '../../../src/shared/lib/db/schema'
import { registerAllAccountProviders } from '../../../src/shared/lib/account-providers/register'
import { dropboxRequest, requireDropboxAccount } from '../../../src/shared/lib/volumes/dropbox-client'
import { DropboxMountableVolume } from '../../../src/shared/lib/volumes/dropbox-mountable-volume'
import { getAccountProviderByName } from '../../../src/shared/lib/account-providers/provider-factory'
import { dropboxVolumeConfigSchema, dropboxMetadataSchema, dropboxListSchema } from '../../../src/shared/lib/volumes/dropbox-schema'
import { WorkspaceFileError } from '../../../src/shared/lib/agent-actor/workspace-path'
import { parseJson, stateSchema, agentSchema, mountSchema, mountsSchema, workerRequestSchema, workerReplySchema, digestSchema, queueSchema, reportSchema, httpSchema, relativePathSchema } from './schema'
import { bytes } from './worker'

const output = process.env.DROPBOX_TEST_OUTPUT ?? '/tmp/gamut-dropbox-live'
const api = process.env.DROPBOX_TEST_API ?? 'http://127.0.0.1:3514/api'
const root = '/gamut-test' as const
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'all'
const caseFilter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7)
const invocation = new Date().toISOString().replace(/[^0-9]/g, '')
let state: z.infer<typeof stateSchema>
let report: z.infer<typeof reportSchema>
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function command(program: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    // 'exit' may precede the final stdout chunk, especially with parallel execs.
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${program} exited ${code}: ${stderr.slice(-2000)}`)))
    child.stdin.end(input)
  })
}
async function app(path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${api}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  if (!response.ok) throw new Error(`App ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}
function remotePath(relative: string): string {
  relativePathSchema.parse(relative)
  return `${root}/${state.runName}${relative ? `/${relative}` : ''}`
}
async function metadata(relative: string) {
  return dropboxMetadataSchema.parse(await (await dropboxRequest(state.accountId, 'get_metadata', { path: remotePath(relative) })).json())
}
async function verify(relative: string, expected: Buffer): Promise<void> {
  const meta = await metadata(relative)
  assert.equal(meta['.tag'], 'file')
  if (meta['.tag'] !== 'file') throw new Error('Not a file')
  assert.equal(meta.size, expected.length, `Dropbox size: ${relative}`)
  const data = Buffer.from(await (await dropboxRequest(state.accountId, 'download', { path: remotePath(relative) })).arrayBuffer())
  assert.equal(data.length, expected.length, `Downloaded length: ${relative}`)
  assert.equal(hash(data), hash(expected), `Downloaded SHA256: ${relative}`)
  report.downloads.push({ path: relative, size: data.length, sha256: hash(data), verifiedAt: new Date().toISOString() })
}
async function absent(relative: string): Promise<void> {
  try { await metadata(relative) } catch (error) {
    if (error instanceof WorkspaceFileError && error.code === 'not-found') return
    throw error
  }
  throw new Error(`Still exists in Dropbox: ${relative}`)
}
async function worker(request: Omit<z.input<typeof workerRequestSchema>, 'runName' | 'attachmentId'>) {
  const input = workerRequestSchema.parse({ ...request, runName: state.runName, attachmentId: state.attachmentId })
  const reply = parseJson(await command('docker', ['exec', '-i', `superagent-${state.agentSlug}`, 'node', '/tmp/gamut-dropbox-worker.cjs', '--worker'], JSON.stringify(input)), workerReplySchema)
  if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code })
  return reply.result
}
async function drain(timeout = 180_000): Promise<void> {
  // close() precedes enqueue in FUSE; require two empty observations after write-back.
  await delay(1_500)
  const start = Date.now()
  let empty = 0, lastLog = start
  while (Date.now() - start < timeout) {
    const all = queueSchema.parse(await worker({ op: 'rc', command: 'vfs/queue' })).queue
    // The large-file phase may run alongside core operations to check that
    // staging a slow upload does not stall ordinary filesystem mutations.
    const largePath = `${state.runName}/large-160mib.bin`
    const queue = all.filter(item => phase === 'large' ? item.name === largePath : ['core', 'edges'].includes(phase) ? item.name !== largePath : true)
    if (queue.length === 0) { if (++empty >= 2) return } else empty = 0
    if (Date.now() - lastLog > 15_000) { console.log(`  waiting: ${queue.length} uploads, max attempts ${Math.max(0, ...queue.map(item => item.tries ?? 0))}`); lastLog = Date.now() }
    await delay(1_000)
  }
  throw new Error('Upload queue did not drain')
}
async function installWorker() {
  const file = `worker-${randomUUID()}.cjs`
  await build({ entryPoints: ['e2e/live/dropbox-volumes/worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: `${output}/${file}` })
  await command('docker', ['cp', `${output}/${file}`, `superagent-${state.agentSlug}:/tmp/${file}`])
  await command('docker', ['exec', `superagent-${state.agentSlug}`, 'mv', `/tmp/${file}`, '/tmp/gamut-dropbox-worker.cjs'])
}
const reportFile = () => `${output}/${state.runName}-${phase}-${invocation}.json`
async function saveReport() { await writeFile(reportFile(), JSON.stringify(reportSchema.parse(report), null, 2)) }
async function test(name: string, run: () => Promise<void>) {
  if (caseFilter && !name.includes(caseFilter)) return
  if (phase === 'core' ? !/^(files|rename|directories|git|batch|webdav|external)\//.test(name) : phase !== 'all' && !name.startsWith(`${phase}/`)) return
  const start = Date.now()
  console.log(`RUN ${name}`)
  try {
    await run()
    report.cases.push({ name, passed: true, durationMs: Date.now() - start })
    console.log(`PASS ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    report.cases.push({ name, passed: false, durationMs: Date.now() - start, error: message })
    console.log(`FAIL ${name}: ${message}`)
    if (error instanceof Error) console.log(error.stack?.split('\n').slice(1, 6).join('\n'))
  }
  await saveReport()
}

async function init() {
  // Only read the selected definition to locate its connected account. Never use
  // that definition's path: all upstream paths in this suite start /gamut-test.
  const id = process.env.DROPBOX_TEST_SOURCE_VOLUME_ID
  if (!id) throw new Error('Set DROPBOX_TEST_SOURCE_VOLUME_ID to select a connected account')
  const row = await db.select().from(volumeDefinitions).where(eq(volumeDefinitions.id, id)).get()
  if (!row || row.type !== 'dropbox') throw new Error('Dropbox source definition not found')
  const { accountId } = parseJson(row.config, dropboxVolumeConfigSchema)
  try {
    const existing = dropboxMetadataSchema.parse(await (await dropboxRequest(accountId, 'get_metadata', { path: root })).json())
    assert.equal(existing['.tag'], 'folder')
    console.log('/gamut-test already exists; this run uses a new isolated child folder')
  } catch (error) {
    if (!(error instanceof WorkspaceFileError) || error.code !== 'not-found') throw error
    await dropboxRequest(accountId, 'create_folder_v2', { path: root, autorename: false })
    console.log('Created Dropbox /gamut-test')
  }
  const agent = agentSchema.parse(await app('/agents', { name: 'Dropbox Integration Test' }))
  const mount = mountSchema.parse(await app(`/agents/${agent.slug}/mounts`, { name: 'gamut-test', type: 'dropbox', config: { accountId, path: root } }))
  state = stateSchema.parse({ accountId, agentSlug: agent.slug, attachmentId: mount.id, volumeId: mount.volumeId, root, mount: '/mounts/gamut-test', runName: `run-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}` })
  await writeFile(`${output}/state.json`, JSON.stringify(stateSchema.parse(state), null, 2), { mode: 0o600 })
  console.log(`Created dedicated test agent ${agent.slug}; starting it`)
  await app(`/agents/${agent.slug}/start`, {})
  await installWorker()
  const mounts = mountsSchema.parse(await app(`/agents/${agent.slug}/mounts`))
  assert.equal(mounts.length, 1, 'Test agent must have only gamut-test mounted')
  await worker({ op: 'mkdir' })
  console.log(`Ready: /gamut-test/${state.runName}`)
}

async function suite() {
  const definitions = await db.select({ volume: volumeDefinitions, mount: agentVolumes }).from(agentVolumes)
    .innerJoin(volumeDefinitions, eq(agentVolumes.volumeId, volumeDefinitions.id)).where(eq(agentVolumes.agentSlug, state.agentSlug)).all()
  assert.equal(definitions.length, 1, 'Refuse an agent with any other mounts')
  assert.equal(definitions[0].mount.id, state.attachmentId)
  assert.equal(definitions[0].mount.name, 'gamut-test')
  assert.equal(definitions[0].volume.type, 'dropbox')
  assert.deepEqual(parseJson(definitions[0].volume.config, dropboxVolumeConfigSchema), { accountId: state.accountId, path: root })
  await installWorker()
  if (process.argv.includes('--new-run')) {
    state.runName = `run-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`
    await worker({ op: 'mkdir' })
    await writeFile(`${output}/state.json`, JSON.stringify(stateSchema.parse(state), null, 2), { mode: 0o600 })
  }
  report = reportSchema.parse({ root, runName: state.runName, agentSlug: state.agentSlug, startedAt: new Date().toISOString(), cases: [] })
  for (const size of [0, 1, 21, 512 * 1024 - 1, 512 * 1024, 512 * 1024 + 1, 5 * 1024 * 1024, 32 * 1024 * 1024]) {
    await test(`sizes/write/read ${size} bytes`, async () => {
      const path = `size-${size}.bin`, seed = path
      const expected = bytes(size, seed)
      await worker({ op: 'write', path, data: { size, seed } })
      await drain(size > 10_000_000 ? 600_000 : 180_000)
      await verify(path, expected)
      assert.equal(digestSchema.parse(await worker({ op: 'read', path })).sha256, hash(expected))
    })
  }
  await test('files/Unicode, spaces, URL-special names and UTF-8 contents', async () => {
    const text = 'Hello Dropbox!\n日本語 — résumé — שלום 🌍\n'
    for (const path of ['Résumé 日本語 🌍.txt', 'spaces & #percent%25 + question?.txt', '.hidden-file']) {
      await worker({ op: 'write', path, text })
      await drain()
      await verify(path, Buffer.from(text))
    }
  })
  await test('files/overwrite then same-size overwrite', async () => {
    const path = 'overwrite.bin'
    for (const [size, seed] of [[2000, 'first'], [1000, 'second'], [1000, 'third']] as const) {
      await worker({ op: 'write', path, data: { size, seed } })
      await drain()
      await verify(path, bytes(size, seed))
    }
  })
  await test('files/append, random seek, truncate, extend, truncate to zero', async () => {
    const path = 'editing.bin'
    let expected = bytes(1000, 'edit')
    await worker({ op: 'write', path, data: { size: 1000, seed: 'edit' } })
    await drain()
    await worker({ op: 'append', path, data: { size: 333, seed: 'append' } })
    expected = Buffer.concat([expected, bytes(333, 'append')])
    await drain(); await verify(path, expected)
    await worker({ op: 'patch', path, offset: 99, data: { size: 100, seed: 'patch' } })
    bytes(100, 'patch').copy(expected, 99)
    await drain(); await verify(path, expected)
    await worker({ op: 'truncate', path, length: 500 })
    expected = expected.subarray(0, 500)
    await drain(); await verify(path, expected)
    await worker({ op: 'truncate', path, length: 900 })
    expected = Buffer.concat([expected, Buffer.alloc(400)])
    await drain(); await verify(path, expected)
    await worker({ op: 'truncate', path, length: 0 })
    await drain(); await verify(path, Buffer.alloc(0))
  })
  await test('files/copy then remove original', async () => {
    const data = { size: 12_345, seed: 'copy' }
    await worker({ op: 'write', path: 'copy-original.bin', data })
    await drain()
    await worker({ op: 'copy', path: 'copy-original.bin', destination: 'copy-destination.bin' })
    await drain()
    await verify('copy-destination.bin', bytes(data.size, data.seed))
    await worker({ op: 'unlink', path: 'copy-original.bin' })
    await absent('copy-original.bin')
    await verify('copy-destination.bin', bytes(data.size, data.seed))
  })
  await test('files/close then immediate rename while upload is pending', async () => {
    const data = { size: 1024 * 1024, seed: 'pending-rename' }
    await worker({ op: 'write', path: 'pending.tmp', data })
    await worker({ op: 'rename', path: 'pending.tmp', destination: 'pending-final.bin' })
    await drain()
    await verify('pending-final.bin', bytes(data.size, data.seed))
    await absent('pending.tmp')
  })
  await test('files/close then immediate delete cancels pending upload', async () => {
    await worker({ op: 'write', path: 'delete-pending.bin', data: { size: 2 * 1024 * 1024, seed: 'delete-pending' } })
    await worker({ op: 'unlink', path: 'delete-pending.bin' })
    await drain()
    await absent('delete-pending.bin')
  })
  await test('rename/file, cross-directory, case-only, same-path', async () => {
    await worker({ op: 'mkdir', path: 'renames' })
    await worker({ op: 'mkdir', path: 'renames/other' })
    const data = { size: 100, seed: 'rename' }
    await worker({ op: 'write', path: 'renames/one.txt', data }); await drain()
    await worker({ op: 'rename', path: 'renames/one.txt', destination: 'renames/two.txt' })
    await absent('renames/one.txt'); await verify('renames/two.txt', bytes(data.size, data.seed))
    await worker({ op: 'rename', path: 'renames/two.txt', destination: 'renames/other/two.txt' })
    await absent('renames/two.txt'); await verify('renames/other/two.txt', bytes(data.size, data.seed))
    await worker({ op: 'rename', path: 'renames/other/two.txt', destination: 'renames/other/TWO.txt' })
    assert.equal((await metadata('renames/other/TWO.txt')).name, 'TWO.txt')
    await worker({ op: 'rename', path: 'renames/other/TWO.txt', destination: 'renames/other/TWO.txt' })
    await verify('renames/other/TWO.txt', bytes(data.size, data.seed))
  })
  await test('rename/replace committed destination and editor temp-save', async () => {
    const destination = 'editor.txt', source = 'editor.tmp'
    await worker({ op: 'write', path: destination, data: { size: 200, seed: 'old-editor' } })
    await worker({ op: 'write', path: source, data: { size: 300, seed: 'new-editor' } })
    await drain()
    await worker({ op: 'rename', path: source, destination })
    await verify(destination, bytes(300, 'new-editor')); await absent(source)
    await worker({ op: 'write', path: source, data: { size: 400, seed: 'next-editor' } })
    await worker({ op: 'rename', path: source, destination })
    await drain()
    await verify(destination, bytes(400, 'next-editor')); await absent(source)
    const listing = dropboxListSchema.parse(await (await dropboxRequest(state.accountId, 'list_folder', { path: remotePath('') })).json())
    assert(!listing.entries.some(entry => entry.name.startsWith('.gamut-rename-')), 'Rename leaked a backup')
  })
  await test('directories/nested mkdir, move populated tree, and delete leaves', async () => {
    await worker({ op: 'mkdir', path: 'tree/a/b/c', recursive: true })
    await worker({ op: 'write', path: 'tree/a/b/c/child.txt', data: { size: 55, seed: 'tree' } })
    await drain()
    await worker({ op: 'rename', path: 'tree/a', destination: 'tree/moved' })
    await absent('tree/a'); await verify('tree/moved/b/c/child.txt', bytes(55, 'tree'))
    await assert.rejects(worker({ op: 'rmdir', path: 'tree/moved/b/c' }))
    await verify('tree/moved/b/c/child.txt', bytes(55, 'tree'))
    await worker({ op: 'unlink', path: 'tree/moved/b/c/child.txt' })
    for (const path of ['tree/moved/b/c', 'tree/moved/b', 'tree/moved', 'tree']) await worker({ op: 'rmdir', path })
    await absent('tree')
  })
  await test('directories/reject collisions, missing parent, and move into itself', async () => {
    await worker({ op: 'mkdir', path: 'errors' })
    await worker({ op: 'mkdir', path: 'errors/folder' })
    await worker({ op: 'write', path: 'errors/file', data: { size: 42, seed: 'errors' } }); await drain()
    for (const request of [
      { op: 'mkdir', path: 'errors/folder' }, { op: 'mkdir', path: 'errors/file/child' },
      { op: 'mkdir', path: 'errors/missing/child' }, { op: 'rename', path: 'errors/folder', destination: 'errors/folder/child' },
      { op: 'rename', path: 'errors/file', destination: 'errors/folder' }, { op: 'rename', path: 'errors/folder', destination: 'errors/file' },
      { op: 'unlink', path: 'errors/missing' },
    ] as const) await assert.rejects(worker(request))
    await verify('errors/file', bytes(42, 'errors'))
    assert.equal((await metadata('errors/folder'))['.tag'], 'folder')
  })
  await test('git/two commits including index.lock replacement', async () => {
    assert.equal(await worker({ op: 'git', path: 'git-repo' }), '')
    await drain(600_000)
    await verify('git-repo/tracked.txt', bytes(200, 'git-second'))
    const index = digestSchema.parse(await worker({ op: 'read', path: 'git-repo/.git/index' }))
    const remote = Buffer.from(await (await dropboxRequest(state.accountId, 'download', { path: remotePath('git-repo/.git/index') })).arrayBuffer())
    assert.equal(hash(remote), index.sha256)
    await absent('git-repo/.git/index.lock')
  })
  await test('batch/40 parallel small uploads and concurrent reads', async () => {
    await worker({ op: 'mkdir', path: 'batch' })
    await parallel(Array.from({ length: 40 }, (_, i) => i), async i => {
      await worker({ op: 'write', path: `batch/${i}.bin`, data: { size: i * 137, seed: `batch-${i}` } })
    })
    await drain(600_000)
    await parallel(Array.from({ length: 40 }, (_, i) => i), async i => {
      await verify(`batch/${i}.bin`, bytes(i * 137, `batch-${i}`))
    })
    const listing = dropboxListSchema.parse(await (await dropboxRequest(state.accountId, 'list_folder', { path: remotePath('batch') })).json())
    assert.equal(listing.entries.length, 40)
  })
  await test('batch/parallel rename, overwrite, delete, and mkdir', async () => {
    await parallel(Array.from({ length: 20 }, (_, i) => i), async i => {
      await worker({ op: 'rename', path: `batch/${i}.bin`, destination: `batch/renamed-${i}.bin` })
      await verify(`batch/renamed-${i}.bin`, bytes(i * 137, `batch-${i}`))
      await absent(`batch/${i}.bin`)
    })
    await parallel(Array.from({ length: 10 }, (_, i) => i + 20), async i => {
      await worker({ op: 'write', path: `batch/${i}.bin`, data: { size: 60, seed: `changed-${i}` } })
    })
    await drain(600_000)
    await parallel(Array.from({ length: 10 }, (_, i) => i + 20), async i => {
      await verify(`batch/${i}.bin`, bytes(60, `changed-${i}`))
    })
    await parallel(Array.from({ length: 10 }, (_, i) => i + 30), async i => {
      await worker({ op: 'unlink', path: `batch/${i}.bin` })
      await absent(`batch/${i}.bin`)
      await worker({ op: 'mkdir', path: `batch/dir-${i}` })
      assert.equal((await metadata(`batch/dir-${i}`))['.tag'], 'folder')
    })
  })
  await test('batch/four concurrent multi-chunk uploads', async () => {
    await parallel([0, 1, 2, 3], async i => {
      await worker({ op: 'write', path: `concurrent-${i}.bin`, data: { size: 3 * 1024 * 1024 + i, seed: `concurrent-${i}` } })
    })
    await drain(600_000)
    await parallel([0, 1, 2, 3], async i => { await verify(`concurrent-${i}.bin`, bytes(3 * 1024 * 1024 + i, `concurrent-${i}`)) })
  })
  await test('webdav/GET, HEAD, byte ranges, PROPFIND and missing paths', async () => {
    const path = 'protocol.bin', data = { size: 10_000, seed: 'protocol' }, expected = bytes(data.size, data.seed)
    assert.equal(httpSchema.parse(await worker({ op: 'webdav', method: 'PUT', path, data })).status, 201)
    await verify(path, expected)
    for (const [range, status, part] of [
      [undefined, 200, expected], ['bytes=0-0', 206, expected.subarray(0, 1)],
      ['bytes=100-999', 206, expected.subarray(100, 1000)], ['bytes=9900-', 206, expected.subarray(9900)],
      ['bytes=-50', 206, expected.subarray(-50)], ['bytes=9950-20000', 206, expected.subarray(9950)],
      ['bytes=10000-', 416, Buffer.alloc(0)],
    ] as const) {
      const response = httpSchema.parse(await worker({ op: 'webdav', method: 'GET', path, headers: range ? { Range: range } : {} }))
      assert.equal(response.status, status, range)
      assert.equal(response.sha256, hash(part), range)
    }
    const head = httpSchema.parse(await worker({ op: 'webdav', method: 'HEAD', path }))
    assert.equal(head.status, 200); assert.equal(head.size, 0); assert.equal(head.headers['content-length'], '10000')
    for (const depth of ['0', '1']) {
      const prop = httpSchema.parse(await worker({ op: 'webdav', method: 'PROPFIND', path: depth === '0' ? path : '', headers: { Depth: depth } }))
      assert.equal(prop.status, 207); assert(prop.text?.includes('protocol.bin'))
    }
    for (const method of ['GET', 'HEAD', 'DELETE'] as const) assert.equal(httpSchema.parse(await worker({ op: 'webdav', method, path: 'never-created' })).status, 404)
    assert.equal(httpSchema.parse(await worker({ op: 'webdav', method: 'PUT', path: 'missing-parent/file', data })).status, 409)
  })
  await test('webdav/simultaneous writes never publish mixed contents', async () => {
    const path = 'competing.bin'
    const replies = await Promise.all(['writer-a', 'writer-b'].map(seed => worker({ op: 'webdav', method: 'PUT', path, data: { size: 600_000, seed } })))
    const statuses = replies.map(reply => httpSchema.parse(reply).status)
    assert(statuses.includes(201)); assert(statuses.every(status => status === 201 || status === 409))
    const downloaded = Buffer.from(await (await dropboxRequest(state.accountId, 'download', { path: remotePath(path) })).arrayBuffer())
    assert(['writer-a', 'writer-b'].some(seed => hash(downloaded) === hash(bytes(600_000, seed))))
  })
  await test('external/size changes, same-size edits and cache refresh', async () => {
    const path = 'external.bin'
    await worker({ op: 'write', path, data: { size: 100, seed: 'external-initial' } }); await drain()
    await worker({ op: 'read', path })
    for (const [size, seed] of [[500, 'external-larger'], [500, 'external-same-size']] as const) {
      // Ensure the timestamp changes even on second-resolution WebDAV clients.
      await delay(1_100)
      await dropboxRequest(state.accountId, 'upload', { path: remotePath(path), mode: 'overwrite', autorename: false }, { bytes: Uint8Array.from(bytes(size, seed)).buffer })
      const prop = httpSchema.parse(await worker({ op: 'webdav', method: 'PROPFIND', path, headers: { Depth: '0' } }))
      assert(prop.text?.includes(`<d:getcontentlength>${size}</d:getcontentlength>`))
      const head = httpSchema.parse(await worker({ op: 'webdav', method: 'HEAD', path }))
      assert.equal(head.headers['content-length'], String(size))
      const get = httpSchema.parse(await worker({ op: 'webdav', method: 'GET', path }))
      assert.equal(get.sha256, hash(bytes(size, seed)), `Fresh WebDAV GET: ${seed}`)
      // rclone refresh can still hit the host's documented 15s listing cache.
      // File PROPFIND/HEAD/GET above must be fresh immediately; FUSE must
      // converge once that last listing snapshot expires.
      const deadline = Date.now() + 20_000
      let actual = ''
      do {
        await worker({ op: 'rc', command: 'vfs/refresh' })
        actual = digestSchema.parse(await worker({ op: 'read', path })).sha256
        if (actual === hash(bytes(size, seed))) break
        await delay(1_000)
      } while (Date.now() < deadline)
      assert.equal(actual, hash(bytes(size, seed)), `Mounted read after host cache expiry: ${seed}`)
    }
  })
  await test('large/160 MiB upload and independent full download', async () => {
    const path = 'large-160mib.bin', data = { size: 160 * 1024 * 1024, seed: 'large-160mib' }
    if (!process.argv.includes('--resume-uploads')) await worker({ op: 'write', path, data })
    await drain(2_400_000)
    await verify(path, bytes(data.size, data.seed))
  })
  await test('lifecycle/restart preserves remote data and cold reads', async () => {
    await drain(600_000)
    await app(`/agents/${state.agentSlug}/stop`, {})
    await app(`/agents/${state.agentSlug}/start`, {})
    await installWorker()
    assert.equal(digestSchema.parse(await worker({ op: 'read', path: 'size-5242880.bin' })).sha256, hash(bytes(5 * 1024 * 1024, 'size-5242880.bin')))
    await verify('size-5242880.bin', bytes(5 * 1024 * 1024, 'size-5242880.bin'))
  })
  await test('lifecycle/immediate stop commits a small upload within the drain budget', async () => {
    const path = 'shutdown.bin', data = { size: 1024 * 1024, seed: 'shutdown' }
    await worker({ op: 'write', path, data })
    const stopped = await fetch(`${api}/agents/${state.agentSlug}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(stopped.status, 200)
    try { await verify(path, bytes(data.size, data.seed)) }
    finally {
      await app(`/agents/${state.agentSlug}/start`, {})
      await installWorker()
    }
    assert.equal(digestSchema.parse(await worker({ op: 'read', path })).sha256, hash(bytes(data.size, data.seed)))
  })
  await test('edges/empty directory replacement', async () => {
    await worker({ op: 'mkdir', path: 'empty-source' })
    await worker({ op: 'mkdir', path: 'empty-destination' })
    await worker({ op: 'rename', path: 'empty-source', destination: 'empty-destination' })
    await absent('empty-source')
    assert.equal((await metadata('empty-destination'))['.tag'], 'folder')
  })
  await test('edges/open file handles survive rename and unlink', async () => {
    const data = { size: 8192, seed: 'open-file' }, expected = bytes(data.size, data.seed)
    await worker({ op: 'write', path: 'open-file.bin', data }); await drain()
    const schema = z.object({ before: digestSchema, after: digestSchema })
    const renamed = schema.parse(await worker({ op: 'open-rename', path: 'open-file.bin', destination: 'open-renamed.bin' }))
    assert.equal(renamed.before.sha256, hash(expected)); assert.equal(renamed.after.sha256, hash(expected))
    await absent('open-file.bin'); await verify('open-renamed.bin', expected)
    const deleted = schema.parse(await worker({ op: 'open-delete', path: 'open-renamed.bin' }))
    assert.equal(deleted.before.sha256, hash(expected)); assert.equal(deleted.after.sha256, hash(expected))
    await absent('open-renamed.bin')
  })
  await test('edges/exclusive create and unsupported links fail safely', async () => {
    const data = { size: 80, seed: 'exclusive' }
    await worker({ op: 'exclusive', path: 'exclusive.bin', data }); await drain()
    await assert.rejects(worker({ op: 'exclusive', path: 'exclusive.bin', data: { size: 10, seed: 'wrong' } }))
    await assert.rejects(worker({ op: 'symlink', path: 'exclusive.bin', destination: 'unsupported-symlink' }))
    await assert.rejects(worker({ op: 'hardlink', path: 'exclusive.bin', destination: 'unsupported-hardlink' }))
    await verify('exclusive.bin', bytes(data.size, data.seed))
    await absent('unsupported-symlink'); await absent('unsupported-hardlink')
  })
  await test('edges/zero-filled sparse extension past end of file', async () => {
    const path = 'sparse.bin', data = { size: 64, seed: 'sparse-tail' }, offset = 1024 * 1024
    await worker({ op: 'write', path, data: { size: 0, seed: '' } }); await drain()
    await worker({ op: 'patch', path, offset, data }); await drain()
    await verify(path, Buffer.concat([Buffer.alloc(offset), bytes(data.size, data.seed)]))
  })
  await test('edges/WebDAV refuses destructive type conflicts and nonempty directory delete', async () => {
    assert.equal(httpSchema.parse(await worker({ op: 'webdav', method: 'MKCOL', path: 'dav-errors' })).status, 201)
    const data = { size: 50, seed: 'dav-errors' }
    assert.equal(httpSchema.parse(await worker({ op: 'webdav', method: 'PUT', path: 'dav-errors/file', data })).status, 201)
    for (const [method, path, expected] of [
      ['DELETE', 'dav-errors', 409], ['PUT', 'dav-errors', 405], ['MKCOL', 'dav-errors', 405],
      ['MKCOL', 'dav-errors/file/child', 409], ['GET', 'dav-errors', 404],
    ] as const) {
      const response = httpSchema.parse(await worker({ op: 'webdav', method, path, ...(method === 'PUT' ? { data } : {}) }))
      assert.equal(response.status, expected, `${method} ${path}`)
    }
    assert.equal(httpSchema.parse(await worker({ op: 'webdav', method: 'MOVE', path: 'dav-errors/file', destination: 'dav-errors' })).status, 409)
    await verify('dav-errors/file', bytes(data.size, data.seed))
    assert.equal(httpSchema.parse(await worker({ op: 'webdav', method: 'PROPFIND', path: 'dav-errors', headers: { Depth: 'infinity' } })).status, 403)
  })
  await test('edges/live paginated Dropbox listing', async () => {
    let page = dropboxListSchema.parse(await (await dropboxRequest(state.accountId, 'list_folder', { path: remotePath('batch'), limit: 5 })).json())
    const entries = new Map<string, z.infer<typeof dropboxMetadataSchema>>()
    const apply = () => {
      for (const entry of page.entries) {
        if (entry['.tag'] === 'deleted') entries.delete(entry.name.toLowerCase())
        else entries.set(entry.name.toLowerCase(), entry)
      }
    }
    apply()
    let pages = 1
    while (page.has_more) {
      page = dropboxListSchema.parse(await (await dropboxRequest(state.accountId, 'list_folder/continue', { cursor: page.cursor })).json())
      apply(); pages++
    }
    assert(pages > 1); assert.equal(entries.size, 40); assert.equal(new Set([...entries.values()].map(entry => entry.id)).size, 40)
  })
  await test('edges/adapter reconciles live deletion records between listing pages', async () => {
    const folder = `pagination-${invocation}`
    await worker({ op: 'mkdir', path: folder })
    await parallel(Array.from({ length: 10 }, (_, i) => i), async i => {
      await worker({ op: 'write', path: `${folder}/${i}.bin`, data: { size: 100, seed: `page-${i}` } })
    })
    await drain(600_000)
    const account = await requireDropboxAccount(state.accountId)
    const provider = getAccountProviderByName(account.providerName)
    const original = provider.makeApiCall
    let deleted = '', pages = 0, tombstones = 0
    // Exercise the actual adapter and transport with small real Dropbox pages.
    // The only injected behavior is page size plus a controlled change to this
    // newly created fixture between the first page and the continuation.
    provider.makeApiCall = async params => {
      const listing = params.targetUrl === 'https://api.dropboxapi.com/2/files/list_folder'
      const continuation = params.targetUrl === 'https://api.dropboxapi.com/2/files/list_folder/continue'
      if (listing) {
        const args = parseJson(Buffer.from(params.body!).toString(), z.object({ path: z.literal(remotePath(folder)) }).passthrough())
        params = { ...params, body: new TextEncoder().encode(JSON.stringify({ ...args, limit: 2 })).buffer }
      }
      const response = await original.call(provider, params)
      if ((listing || continuation) && response.ok) {
        const page = dropboxListSchema.parse(await response.clone().json())
        pages++
        tombstones += page.entries.filter(entry => entry['.tag'] === 'deleted').length
        if (listing) {
          assert(page.has_more)
          const victim = page.entries.find(entry => entry['.tag'] === 'file')!
          assert(victim)
          deleted = victim.name
          await dropboxRequest(state.accountId, 'delete_v2', { path: remotePath(`${folder}/${deleted}`) })
          await dropboxRequest(state.accountId, 'upload', { path: remotePath(`${folder}/created-during-list.bin`), mode: 'add', autorename: false }, { bytes: Uint8Array.from(bytes(100, 'during-list')).buffer })
        }
      }
      return response
    }
    try {
      const volume = new DropboxMountableVolume('', '', { accountId: state.accountId, path: remotePath(folder) })
      const actual = await volume.list('')
      const expected = Array.from({ length: 10 }, (_, i) => `${i}.bin`).filter(name => name !== deleted).concat('created-during-list.bin')
      assert.deepEqual(actual.map(entry => entry.name).sort(), expected.sort())
      assert(pages > 1); assert(tombstones > 0)
      console.log(`  reconciled ${pages} live pages, including ${tombstones} deletion records`)
    } finally { provider.makeApiCall = original }
    await verify(`${folder}/created-during-list.bin`, bytes(100, 'during-list'))
    await worker({ op: 'rc', command: 'vfs/refresh', path: folder })
  })
  await test('scan/cold recursive scan matches Dropbox files and sizes', async () => {
    await drain(600_000)
    await worker({ op: 'rc', command: 'vfs/forget' })
    const mounted = z.array(z.object({ path: z.string(), size: z.number() })).parse(await worker({ op: 'walk' }))
    const actual: { path: string; size: number }[] = []
    const walk = async (relative: string) => {
      let page = dropboxListSchema.parse(await (await dropboxRequest(state.accountId, 'list_folder', { path: remotePath(relative), limit: 100 })).json())
      const entries = [...page.entries]
      while (page.has_more) {
        page = dropboxListSchema.parse(await (await dropboxRequest(state.accountId, 'list_folder/continue', { cursor: page.cursor })).json())
        entries.push(...page.entries)
      }
      const current = new Map<string, z.infer<typeof dropboxMetadataSchema>>()
      for (const entry of entries) {
        if (entry['.tag'] === 'deleted') current.delete(entry.name.toLowerCase())
        else current.set(entry.name.toLowerCase(), entry)
      }
      for (const entry of current.values()) {
        const child = `${relative ? `${relative}/` : ''}${entry.name}`
        if (entry['.tag'] === 'folder') await walk(child)
        else actual.push({ path: child, size: entry.size })
      }
    }
    await walk('')
    const compare = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)
    assert.deepEqual(mounted.sort(compare), actual.sort(compare))
    console.log(`  verified ${actual.length} files in the recursive scan`)
  })
  console.log(`Results: ${report.cases.filter(item => item.passed).length}/${report.cases.length} passed`)
  console.log(`Report: ${reportFile()}`)
  if (report.cases.some(item => !item.passed)) process.exitCode = 1
}

async function parallel<T>(items: T[], run: (item: T) => Promise<void>, concurrency = 4) {
  let next = 0
  const results = await Promise.allSettled(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) await run(items[next++])
  }))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '))
}

async function main() {
  await openDatabase()
  try {
    registerAllAccountProviders()
    await mkdir(output, { recursive: true })
    if (process.argv.includes('--init')) await init()
    else {
      state = stateSchema.parse(JSON.parse(await readFile(`${output}/state.json`, 'utf8')))
      await suite()
    }
  } finally { await closeDatabase() }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
