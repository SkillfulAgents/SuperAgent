import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { removeGithubSync } from './github-sync'
import { GithubMountableVolume } from './github-mountable-volume'
import { blobSha, loadSyncState } from './github-sync-state'
import { VolumeError } from './volume-error'
import { githubTreeSchema, type GithubVolumeConfig } from './github-schema'

const client = vi.hoisted(() => ({ githubHead: vi.fn(), githubTree: vi.fn(), githubTarball: vi.fn(), githubBlob: vi.fn() }))
vi.mock('./github-client', () => client)
vi.mock('@shared/lib/db', () => ({ db: {} }))
const config: GithubVolumeConfig = { accountId: 'account', repoId: 123, owner: 'team', repo: 'project', branch: 'main', path: '' }
let dataDir: string, head: string
let remote: Record<string, Buffer>
let modes: Map<string, string>
let archiveFiles: Record<string, Buffer> | undefined

beforeEach(async () => {
  vi.resetAllMocks()
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'github-sync-test-')))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  modes = new Map(); archiveFiles = undefined; head = 'a'.repeat(40)
  client.githubHead.mockImplementation(async () => head)
  client.githubTree.mockImplementation(async () => githubTreeSchema.parse({ tree: Object.entries(remote).map(([name, bytes]) => ({ path: name, sha: blobSha(bytes), mode: modes.get(name) ?? '100644', type: modes.get(name) === '160000' ? 'commit' : 'blob' })), truncated: false }).tree)
  client.githubBlob.mockImplementation(async (_config, sha) => Object.values(remote).find(bytes => blobSha(bytes) === sha))
  client.githubTarball.mockImplementation(async () => {
    const fixture = path.join(dataDir, 'fixture')
    await fs.rm(fixture, { recursive: true, force: true })
    await fs.mkdir(path.join(fixture, 'team-project-abcdef'), { recursive: true })
    for (const [name, bytes] of Object.entries(archiveFiles ?? remote)) {
      const target = path.join(fixture, 'team-project-abcdef', name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes, { mode: parseInt(modes.get(name) ?? '100644', 8) })
    }
    return new Response(new Uint8Array(await tar.c({ cwd: fixture, gzip: true }, ['team-project-abcdef']).concat()))
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await removeGithubSync('volume')
  await fs.rm(dataDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
async function setup(files: Record<string, string | Buffer> = { 'notes.txt': 'kept' }, { selected = '', start = true } = {}) {
  remote = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)]))
  const row = { id: 'volume', name: 'Project', type: 'github' as const, config: { ...config, path: selected } }
  const volume = new GithubMountableVolume(row.id, row.name, row.config)
  const sync = volume.sync
  if (start) await sync.run()
  const copy = (name = '') => path.join(sync.local.config.path, name)
  return { row, volume, sync, copy, read: (name = 'notes.txt') => fs.readFile(copy(name)), state: () => loadSyncState(sync.folder) }
}

it('copies the selected folder byte-exactly', async () => {
  const files = { 'selected/binary': Buffer.from([0, 255, 128, 10]), 'selected/nested/json': '{"exact": true}\n' }
  archiveFiles = { ...Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes)])), outside: Buffer.from('outside') }
  const { row, copy, read } = await setup(files, { selected: 'selected' })
  for (const name of ['binary', 'nested/json']) expect(await read(name)).toEqual(remote[`selected/${name}`])
  expect((await fs.readdir(copy())).sort()).toEqual(['binary', 'nested'])
  expect(client.githubTarball).toHaveBeenCalledExactlyOnceWith(row.config, head)
})

it('names both first-copy clashes, clears on a clean snapshot, and keeps serving through a pull clash', async () => {
  const stat = fs.stat
  vi.spyOn(fs, 'stat').mockImplementation((name, options) => stat(String(name).replace(/(case-[\w-]+-)A$/, '$1a'), options))
  const { volume, sync, read } = await setup({ 'Folder/a': 'one', 'folder/b': 'two' })
  await expect(sync.ready()).rejects.toEqual(expect.objectContaining({ constructor: WorkspaceFileError, code: 'not-accessible', message: expect.stringMatching(/Folder.*folder/) }))
  expect(client.githubTarball).not.toHaveBeenCalled()
  delete remote['folder/b']
  await sync.run()
  await expect(volume.health()).resolves.toMatchObject({ kind: 'directory' })
  remote['folder/b'] = Buffer.from('two'); remote['Folder/a'] = Buffer.from('changed'); head = 'b'.repeat(40)
  await sync.run()
  expect(await volume.list('Folder')).toHaveLength(1)
  expect(await read('Folder/a')).toEqual(Buffer.from('one'))
  expect(client.githubTarball).toHaveBeenCalledOnce()
})

it('pulls only changed paths, including mode-only changes, deletes, and file/folder replacements', async () => {
  const { sync, copy, read } = await setup({ 'notes.txt': 'kept', executable: 'same', changed: 'old', constructor: 'deleted', file: 'old', 'folder/child': 'old' }, { start: false })
  const pull = path.join(sync.folder, 'pull')
  await fs.mkdir(pull, { recursive: true }); await fs.writeFile(path.join(pull, 'interrupted'), 'old')
  await sync.loaded
  await expect(fs.stat(pull)).rejects.toMatchObject({ code: 'ENOENT' })
  await sync.run()
  await fs.mkdir(pull); await fs.writeFile(path.join(pull, 'stale'), 'old')
  remote = { 'notes.txt': Buffer.from('kept'), executable: Buffer.from('same'), changed: Buffer.from('new'), 'file/child': Buffer.from('child'), folder: Buffer.from('file') }
  modes.set('executable', '100755'); head = 'b'.repeat(40)
  const rename = vi.spyOn(fs, 'rename')
  let staged: string[] | undefined
  const tarball = client.githubTarball.getMockImplementation()
  client.githubTarball.mockClear().mockImplementationOnce(async (...args) => { staged = await fs.readdir(pull); return tarball?.(...args) })
  await sync.run()
  expect(staged).toEqual([])
  expect(client.githubTarball).toHaveBeenCalledExactlyOnceWith(config, head)
  expect(rename.mock.calls.map(([, target]) => String(target)).filter(target => target.startsWith(copy() + '/')).sort()).toEqual(['changed', 'executable', 'file/child', 'folder'].map(copy).sort())
  for (const [name, bytes] of Object.entries(remote)) expect(await read(name)).toEqual(bytes)
  expect((await fs.stat(copy('executable'))).mode & 0o777).toBe(0o755)
  await expect(fs.stat(copy('constructor'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(pull)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('streams ranges without buffering or writing state while one stale-head check runs', async () => {
  const { volume, sync } = await setup({ 'notes.txt': 'hello world' })
  const readFile = vi.spyOn(fs, 'readFile'), write = vi.spyOn(fs, 'writeFile'), rename = vi.spyOn(fs, 'rename')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
  let release = () => {}
  client.githubHead.mockClear().mockReturnValueOnce(new Promise<string>(resolve => { release = () => resolve(head) }))
  try {
    const file = await volume.read('notes.txt')
    expect(file.size).toBe(11)
    expect(await new Response(await file.stream({ start: 2, end: 6 })).text()).toBe('llo w')
    expect(await volume.list('')).toHaveLength(1)
    for (const spy of [readFile, write, rename]) expect(spy).not.toHaveBeenCalled()
  } finally { release(); await sync.run() }
  await volume.list('')
  expect(client.githubHead).toHaveBeenCalledOnce()
})

it('refuses mutations and cancels uploads without changing the copy', async () => {
  const { volume, read } = await setup()
  const cancel = vi.fn()
  for (const operation of [volume.write('notes.txt', new ReadableStream({ cancel })), volume.delete('notes.txt'), volume.mkdir('folder'), volume.move('notes.txt', 'other')]) await expect(operation).rejects.toMatchObject({ code: 'not-accessible' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(await read()).toEqual(Buffer.from('kept'))
})

it('serves through account revocation, then resumes after reconnect', async () => {
  const { volume, sync, read } = await setup()
  client.githubHead.mockRejectedValueOnce(new WorkspaceFileError('not-accessible'))
  await sync.run()
  client.githubHead.mockClear()
  expect(await new Response(await (await volume.read('notes.txt')).stream()).text()).toBe('kept')
  expect(client.githubHead).not.toHaveBeenCalled()
  remote['notes.txt'] = Buffer.from('resumed'); head = 'b'.repeat(40)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
  await volume.list('')
  await sync.run()
  expect(client.githubHead).toHaveBeenCalledOnce()
  expect(await read()).toEqual(remote['notes.txt'])
})

it('advances an empty or deletion-only delta without downloading', async () => {
  const { volume, sync, state } = await setup()
  client.githubTarball.mockClear(); client.githubBlob.mockClear()
  for (const files of [remote, {}]) {
    remote = files; head = head === 'a'.repeat(40) ? 'b'.repeat(40) : 'c'.repeat(40)
    await sync.run()
    expect((await state()).base).toBe(head)
  }
  expect(await volume.list('')).toEqual([])
  for (const download of [client.githubTarball, client.githubBlob]) expect(download).not.toHaveBeenCalled()
})

it('retries a failed load and first copy through health alone', async () => {
  vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'))
  client.githubHead.mockRejectedValueOnce(new VolumeError('offline', 503))
  const { volume } = await setup(undefined, { start: false })
  await vi.waitFor(async () => { await expect(volume.health()).rejects.toMatchObject({ reason: 'GitHub copy failed' }) })
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
  await vi.waitFor(async () => { await expect(volume.health()).rejects.toMatchObject({ reason: 'offline' }) })
  now.mockReturnValue(Date.now() + 30_000)
  await vi.waitFor(async () => { await expect(volume.health()).resolves.toMatchObject({ kind: 'directory' }) })
  expect(client.githubHead).toHaveBeenCalledTimes(2)
})

it('serves an existing copy after restart without a start call or waiting for GitHub', async () => {
  const { row, sync } = await setup()
  vi.resetModules()
  const { GithubMountableVolume: RestartedVolume } = await import('./github-mountable-volume')
  const { removeGithubSync: removeRestartedSync } = await import('./github-sync')
  let release = () => {}
  client.githubHead.mockClear().mockReturnValueOnce(new Promise<string>(resolve => { release = () => resolve(head) }))
  client.githubTarball.mockClear()
  const volume = new RestartedVolume(row.id, row.name, row.config)
  expect(volume.sync).not.toBe(sync)
  expect(client.githubHead).not.toHaveBeenCalled()
  try {
    await expect(volume.health()).resolves.toMatchObject({ kind: 'directory' })
    expect(await volume.list('')).toHaveLength(1)
    expect(await new Response(await (await volume.read('notes.txt')).stream()).text()).toBe('kept')
    expect(client.githubHead).toHaveBeenCalledOnce()
    expect(client.githubTarball).not.toHaveBeenCalled()
  } finally {
    release()
    await removeRestartedSync(row.id)
  }
})

it('fetches export-ignore omissions and export-subst bytes by blob sha', async () => {
  archiveFiles = { substituted: Buffer.from('expanded commit') }
  const { read } = await setup({ 'ignored/binary': '\0binary', substituted: '$Format:%H$' })
  for (const [name, bytes] of Object.entries(remote)) {
    expect(await read(name)).toEqual(bytes)
    expect(client.githubBlob).toHaveBeenCalledWith(config, blobSha(bytes))
  }
})

it('removes the folder and releases the owner', async () => {
  const { row, sync } = await setup()
  await removeGithubSync(row.id)
  await expect(fs.stat(sync.folder)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(sync.ready()).rejects.toMatchObject({ code: 'not-found' })
  expect(new GithubMountableVolume(row.id, row.name, row.config).sync).not.toBe(sync)
})
