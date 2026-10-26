import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { backgroundSettled } from '@shared/lib/background'
import { removeGithubSync } from './github-sync'
import { GithubMountableVolume } from './github-mountable-volume'
import { blobSha, loadSyncState } from './github-sync-state'
import { VolumeError } from './volume-error'
import { githubTreeSchema, type GithubVolumeConfig } from './github-schema'
import type { GithubTrees } from './github-client'

const client = vi.hoisted(() => ({ githubHead: vi.fn(), githubTree: vi.fn(), githubTarball: vi.fn(), githubBlob: vi.fn(), githubRepo: vi.fn(), githubCommit: vi.fn() }))
vi.mock('./github-client', () => client)
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/services/agent-service', () => ({ getAgentRecord: async (slug: string) => slug === 'writer' ? { name: 'Writer Agent' } : null }))
const config: GithubVolumeConfig = { accountId: 'account', repoId: 123, owner: 'team', repo: 'project', branch: 'main', path: '' }
let dataDir: string, head: string
let remote: Record<string, Buffer>
let modes: Map<string, string>
let archiveFiles: Record<string, Buffer> | undefined
/** Whether listings report sizes, and sizes they report other than the bytes' own. */
let sized = false
let sizes: Map<string, number>
let commits: string[]
const history: Buffer[] = []

beforeEach(async () => {
  vi.resetAllMocks()
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'github-sync-test-')))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  modes = new Map(); archiveFiles = undefined; sized = false; sizes = new Map(); head = 'a'.repeat(40); commits = []
  client.githubHead.mockImplementation(async () => head)
  client.githubTree.mockImplementation(async () => githubTreeSchema.parse({ tree: Object.entries(remote).map(([name, bytes]) => ({ path: name, sha: blobSha(bytes), mode: modes.get(name) ?? '100644', type: modes.get(name) === '160000' ? 'commit' : 'blob', ...(sized ? { size: sizes.get(name) ?? bytes.length } : {}) })), truncated: false }).tree)
  client.githubBlob.mockImplementation(async (_config, sha) => [...Object.values(remote), ...history].find(bytes => blobSha(bytes) === sha))
  client.githubCommit.mockImplementation(async (_config, expected: string, changes: { path: string; contents: Buffer | null }[], headline: string) => {
    if (expected !== head) throw new WorkspaceFileError('not-accessible', `is at ${head} but expected ${expected}`)
    for (const change of changes) {
      if (remote[change.path]) history.push(remote[change.path])
      if (change.contents) remote[change.path] = change.contents
      else delete remote[change.path]
    }
    commits.push(headline)
    return head = String(commits.length).padStart(40, 'c')
  })
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
  const volume = new GithubMountableVolume(row.id, row.name, row.config, row.id, 'writer')
  const sync = volume.sync
  if (start) await sync.run()
  const copy = (name = '') => path.join(sync.local.config.path, name)
  const write = (name: string, text: string) => volume.write(name, new Blob([text]).stream())
  const text = async (name: string) => new Response(await (await volume.read(name)).stream()).text()
  return { row, volume, sync, copy, write, text, read: (name = 'notes.txt') => fs.readFile(copy(name)), state: () => loadSyncState(sync.folder) }
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

it('pushes writes, a delete and a folder move as one commit, and keeps a write made while it was in flight', async () => {
  const { volume, sync, write, state } = await setup({ 'notes.txt': 'kept', 'old/a.txt': 'a', 'gone.txt': 'x' })
  await write('notes.txt', 'edited')
  await volume.delete('gone.txt')
  await volume.move('old', 'new')
  let release = () => {}
  const commit = client.githubCommit.getMockImplementation()!
  client.githubCommit.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return commit(...args) })
  const pushing = sync.run(true)
  await vi.waitFor(() => expect(client.githubCommit).toHaveBeenCalledOnce())
  await write('notes.txt', 'during')
  release()
  await pushing
  expect(commits).toEqual(['Update 4 files from Writer Agent'])
  expect(Object.keys(remote).sort()).toEqual(['new/a.txt', 'notes.txt'])
  expect(remote['notes.txt']).toEqual(Buffer.from('edited'))
  expect(sync.unpushed).toBe(1)
  await sync.run(true)
  expect(remote['notes.txt']).toEqual(Buffer.from('during'))
  expect(sync.unpushed).toBe(0)
  expect((await state()).base).toBe(head)
})

it('merges a write against the first version that mount read, across a pull', async () => {
  const { sync, write, text } = await setup({ 'notes.txt': 'one\ntwo\nthree\n' })
  await text('notes.txt')
  teammate({ 'notes.txt': 'one\ntwo\nTHREE\n' })
  await sync.run()
  await write('notes.txt', 'ONE\ntwo\nthree\n')
  expect(await text('notes.txt')).toBe('ONE\ntwo\nTHREE\n')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('ONE\ntwo\nTHREE\n')
})

it("keeps a teammate's change when the agent writes back the version it first read, even twice, and lands the revert once written after a read", async () => {
  const { sync, write, text } = await setup({ 'notes.txt': 'A' })
  await text('notes.txt')
  teammate({ 'notes.txt': 'B' })
  await sync.run()
  await write('notes.txt', 'A')
  await write('notes.txt', 'A')
  await sync.run(true)
  expect([commits, sync.attention]).toEqual([[], null])
  expect(await text('notes.txt')).toBe('B')
  await write('notes.txt', 'A')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('A')
})

async function conflicted() {
  const drive = await setup({ 'notes.txt': 'one\ntwo\n' })
  await drive.text('notes.txt')
  await drive.write('notes.txt', 'AGENT\ntwo\n')
  teammate({ 'notes.txt': 'TEAM\ntwo\n' })
  await drive.sync.run(true)
  return { ...drive, marked: await drive.text('notes.txt') }
}

it('labels a same-line conflict with how to resolve it, never pushes markers, and pushes the rewrite', async () => {
  const { sync, write, marked } = await conflicted()
  expect(marked).toMatch(/^<<<<<<< Agent's version\nAGENT\n=======\nTEAM\n>>>>>>> GitHub [0-9a-f]{12} \(remove these markers to sync this file\)\ntwo\n$/)
  await write('notes.txt', `${marked}more\n`)
  await sync.run(true)
  expect(commits).toEqual([])
  expect(sync.attention).toMatchObject({ badge: { label: '1 conflict', tone: 'warning' }, detail: 'notes.txt (conflict markers to resolve)', unsynced: 1 })
  await write('notes.txt', 'BOTH\ntwo\n')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('BOTH\ntwo\n')
})

it("keeps GitHub's version when the agent deletes a conflicted file", async () => {
  const { volume, sync, text } = await conflicted()
  await volume.delete('notes.txt')
  expect(await text('notes.txt')).toBe('TEAM\ntwo\n')
  expect(sync.attention).toBeNull()
  await sync.run(true)
  expect(commits).toEqual([])
})

it('leaves a conflicted file alone on pull, and merges what GitHub changed meanwhile into its rewrite', async () => {
  const { sync, write, text, marked } = await conflicted()
  teammate({ 'notes.txt': 'TEAM\ntwo\nthree\n' })
  await sync.run()
  expect(await text('notes.txt')).toBe(marked)
  await write('notes.txt', 'RESOLVED\ntwo\n')
  expect(await text('notes.txt')).toBe('RESOLVED\ntwo\nthree\n')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('RESOLVED\ntwo\nthree\n')
})

it('merges a save by rename onto a tracked file like a write', async () => {
  const { volume, sync, write, text } = await setup({ 'notes.txt': 'one\nmid\ntwo\n' })
  await text('notes.txt')
  teammate({ 'notes.txt': 'ONE\nmid\ntwo\n' })
  await sync.run()
  await write('notes.tmp', 'one\nmid\nTWO\n')
  await volume.move('notes.tmp', 'notes.txt')
  await sync.run(true)
  expect(remote).toEqual({ 'notes.txt': Buffer.from('ONE\nmid\nTWO\n') })
})

it('keeps the source of a save by rename when another write replaces it mid-move', async () => {
  const { volume, sync, write, text } = await setup({ 'notes.txt': 'one\n' })
  await text('notes.txt')
  await write('notes.tmp', 'two\n')
  const original = sync.write.bind(sync)
  vi.spyOn(sync, 'write').mockImplementationOnce(async (...args) => { await original(...args); await write('notes.tmp', 'three\n') })
  await volume.move('notes.tmp', 'notes.txt')
  await sync.run(true)
  expect(remote).toEqual({ 'notes.txt': Buffer.from('two\n'), 'notes.tmp': Buffer.from('three\n') })
})

it('retries a lost reply on an unmoved head, and clears an edit whose commit landed before its reply was lost', async () => {
  const { sync, write } = await setup()
  await write('notes.txt', 'first')
  client.githubCommit.mockRejectedValueOnce(new VolumeError('GitHub is temporarily unavailable. Please try again.', 503))
  await sync.run(true)
  expect(client.githubCommit).toHaveBeenCalledTimes(2)
  expect(remote['notes.txt'].toString()).toBe('first')
  await write('notes.txt', 'second')
  const commit = client.githubCommit.getMockImplementation()!
  client.githubCommit.mockImplementationOnce(async (...args) => { await commit(...args); throw new VolumeError('lost', 503) })
  await sync.run(true)
  expect(commits).toHaveLength(2)
  expect(sync.unpushed).toBe(0)
  expect(sync.attention).toBeNull()
})

it('pulls and retries when another push wins the race, and on a refusal at an unmoved head says why and retries on the next use', async () => {
  const { row, sync, write } = await setup({ 'notes.txt': 'kept', 'other.txt': 'o' })
  await write('notes.txt', 'mine')
  const commit = client.githubCommit.getMockImplementation()!
  client.githubCommit.mockImplementationOnce(async (...args) => { teammate({ 'other.txt': 'theirs' }); return commit(...args) })
  await sync.run(true)
  expect([remote['notes.txt'].toString(), remote['other.txt'].toString()]).toEqual(['mine', 'theirs'])
  await write('notes.txt', 'protected')
  client.githubCommit.mockRejectedValueOnce(new WorkspaceFileError('not-accessible', 'GitHub refused the push: protected branch'))
  await sync.run(true)
  expect(sync.attention).toMatchObject({ badge: { label: 'Sync stopped', tone: 'error' }, detail: expect.stringContaining('GitHub refused the push: protected branch') })
  expect(new GithubMountableVolume(row.id, row.name, row.config).readOnly).toBe(false)
  await sync.run()
  expect([remote['notes.txt'].toString(), sync.attention]).toEqual(['protected', null])
})

it("keeps paths the repo root's .gitignore matches local on a subfolder drive", async () => {
  const { volume, sync, write } = await setup({ '.gitignore': 'node_modules/\n', 'web/app.ts': 'app' }, { selected: 'web' })
  await volume.mkdir('node_modules')
  await write('node_modules/index.js', 'built')
  await write('app.ts', 'edited')
  expect(sync.unpushed).toBe(1)
  await sync.run(true)
  expect(Object.keys(remote).sort()).toEqual(['.gitignore', 'web/app.ts'])
})

it('finishes a pull a crash interrupted, after a restart, without changing what it already applied', async () => {
  const { row, sync, write, text, copy } = await setup({ 'a.txt': 'one\nmid\ntwo\n', 'b.txt': 'b' })
  await text('a.txt')
  await write('a.txt', 'ONE\nmid\ntwo\n')
  teammate({ 'a.txt': 'one\nmid\nTWO\n', 'b.txt': 'B' })
  const rename = fs.rename
  const crash = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === copy('b.txt')) throw new Error('crash')
    return rename(from, to)
  })
  await sync.run()
  crash.mockRestore()
  expect([await fs.readFile(copy('a.txt'), 'utf8'), await fs.readFile(copy('b.txt'), 'utf8')]).toEqual(['ONE\nmid\nTWO\n', 'b'])
  vi.resetModules()
  const { GithubMountableVolume: RestartedVolume } = await import('./github-mountable-volume')
  const { removeGithubSync: removeRestartedSync } = await import('./github-sync')
  try {
    await new RestartedVolume(row.id, row.name, row.config).sync.run()
    expect([await fs.readFile(copy('a.txt'), 'utf8'), await fs.readFile(copy('b.txt'), 'utf8')]).toEqual(['ONE\nmid\nTWO\n', 'B'])
  } finally { await removeRestartedSync(row.id) }
})

it('refuses to copy a drive again when its sync state is gone but it holds edits', async () => {
  const { row, sync, write, copy } = await setup()
  await write('notes.txt', 'edited')
  await fs.rm(path.join(sync.folder, 'sync.json'))
  vi.resetModules()
  const { GithubMountableVolume: RestartedVolume } = await import('./github-mountable-volume')
  const { removeGithubSync: removeRestartedSync } = await import('./github-sync')
  try {
    const restarted = new RestartedVolume(row.id, row.name, row.config)
    await restarted.sync.run()
    await expect(restarted.health()).rejects.toMatchObject({ reason: 'The drive has changes that are not on GitHub, but its copy or sync state is missing.' })
    expect(await fs.readFile(copy('notes.txt'), 'utf8')).toBe('edited')
  } finally { await removeRestartedSync(row.id) }
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

it('after a restart, waits for GitHub at most 5 s before serving the copy, once for all reads of that check', async () => {
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await expect(volume.health()).resolves.toMatchObject({ kind: 'directory' })
    const listing = volume.list('')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await listing).toHaveLength(1)
    expect(await new Response(await (await volume.read('notes.txt')).stream()).text()).toBe('kept')
    expect(client.githubHead).toHaveBeenCalledOnce()
    expect(client.githubTarball).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
    release()
    await removeRestartedSync(row.id)
  }
})

it('waits for the check on the first read after 30 s, so it returns what a teammate pushed meanwhile', async () => {
  const { volume } = await setup()
  remote['notes.txt'] = Buffer.from('pushed'); head = 'b'.repeat(40)
  const text = async () => new Response(await (await volume.read('notes.txt')).stream()).text()
  expect(await text()).toBe('kept')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
  expect(await text()).toBe('pushed')
})

it('pulls a small change file by file, and many files or large ones from the archive', async () => {
  sized = true
  const { sync, read } = await setup({ 'notes.txt': 'kept', 'changed.txt': 'old' })
  expect(client.githubTarball).not.toHaveBeenCalled()
  client.githubBlob.mockClear()
  remote['changed.txt'] = Buffer.from('new'); head = 'b'.repeat(40)
  await sync.run()
  expect(await read('changed.txt')).toEqual(Buffer.from('new'))
  expect(client.githubTarball).not.toHaveBeenCalled()
  expect(client.githubBlob).toHaveBeenCalledExactlyOnceWith(config, blobSha(Buffer.from('new')))
  for (let i = 0; i < 33; i++) remote[`many-${i}`] = Buffer.from(String(i))
  head = 'c'.repeat(40)
  await sync.run()
  expect(client.githubTarball).toHaveBeenCalledExactlyOnceWith(config, head)
  expect(await read('many-32')).toEqual(Buffer.from('32'))
  remote.big = Buffer.from('big'); sizes.set('big', 8_000_001); head = 'd'.repeat(40)
  await sync.run()
  expect(client.githubTarball).toHaveBeenLastCalledWith(config, head)
  expect(await read('big')).toEqual(remote.big)
})

it('lets every blob fetch of a failed pull end before the next pull stages', async () => {
  sized = true
  const { sync, read } = await setup({ a: 'a1', b: 'b1' })
  const original = client.githubBlob.getMockImplementation()!
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  remote = { a: Buffer.from('a2'), b: Buffer.from('b2') }; head = 'b'.repeat(40)
  client.githubBlob.mockImplementation(async (config, sha) => {
    if (sha === blobSha(Buffer.from('a2'))) { await held; return original(config, sha) }
    if (sha === blobSha(Buffer.from('b2'))) throw new VolumeError('GitHub is temporarily unavailable. Please try again.', 503)
    return original(config, sha)
  })
  let ended = false
  const failing = sync.run().then(() => { ended = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(ended).toBe(false)
  release()
  await failing
  client.githubBlob.mockImplementation(original)
  remote.a = Buffer.from('a3'); head = 'c'.repeat(40)
  await sync.run()
  expect([(await read('a')).toString(), (await read('b')).toString()]).toEqual(['a3', 'b2'])
})

it('keeps the folder listings of a walk for the next one, and drops them when the listing keeps none', async () => {
  const listing = client.githubTree.getMockImplementation()!
  const folder = 'e'.repeat(40)
  const knownAtCall: string[][] = []
  client.githubTree.mockImplementation(async (config, sha, known: GithubTrees) => { knownAtCall.push([...known.keys()]); known.set(folder, []); return listing(config, sha, known) })
  const { sync } = await setup()
  remote['notes.txt'] = Buffer.from('changed'); head = 'b'.repeat(40)
  await sync.run()
  expect(knownAtCall).toEqual([[], [folder]])
  client.githubTree.mockImplementation(async (config, sha, known: GithubTrees) => { known.clear(); return listing(config, sha, known) })
  head = 'c'.repeat(40)
  await sync.run()
  await expect(fs.stat(path.join(sync.folder, 'trees.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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

it('pushes edits waiting from before a restart on the first touch after it', async () => {
  const { row, write } = await setup()
  await write('notes.txt', 'before restart')
  vi.resetModules()
  const { GithubMountableVolume: RestartedVolume } = await import('./github-mountable-volume')
  const { removeGithubSync: removeRestartedSync } = await import('./github-sync')
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const volume = new RestartedVolume(row.id, row.name, row.config, row.id, 'writer')
    await volume.health()
    await vi.advanceTimersByTimeAsync(15_000)
    await volume.sync.run()
    expect(remote['notes.txt'].toString()).toBe('before restart')
  } finally {
    vi.useRealTimers()
    await removeRestartedSync(row.id)
  }
})

it('treats a move onto itself as nothing', async () => {
  const { volume, sync, text } = await setup()
  await volume.move('notes.txt', 'notes.txt')
  expect([await text('notes.txt'), sync.unpushed]).toEqual(['kept', 0])
})

it('holds both sides of a tracked file moved onto a tracked workflow', async () => {
  const { volume, sync } = await setup({ 'notes.txt': 'kept', '.github/workflows/ci.yml': 'old' })
  await volume.move('notes.txt', '.github/workflows/ci.yml')
  await sync.run(true)
  expect(commits).toEqual([])
  expect(sync.attention?.detail).toContain('notes.txt (under .github/workflows)')
})

it('drops an upload whose client went away', async () => {
  const { volume, sync, text } = await setup()
  const abort = new AbortController()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('late')) }, pull() { abort.abort() } })
  await expect(volume.write('notes.txt', body, abort.signal)).rejects.toMatchObject({ status: 409 })
  expect([await text('notes.txt'), sync.unpushed]).toEqual(['kept', 0])
})

it("holds a local file GitHub just added too, syncs the rest, and places GitHub's once the local one goes", async () => {
  const { sync, volume, write, text } = await setup({ 'notes.txt': 'kept', '.gitignore': 'secret.txt\n' })
  await write('secret.txt', 'mine')
  teammate({ 'secret.txt': 'theirs', 'notes.txt': 'pulled' })
  await sync.run()
  expect([await text('secret.txt'), await text('notes.txt')]).toEqual(['mine', 'pulled'])
  expect(sync.attention).toEqual({ badge: { label: '1 conflict', tone: 'warning' }, detail: 'secret.txt (added on GitHub too)', unsynced: 0 })
  await write('other.txt', 'pushed')
  await sync.run(true)
  expect([remote['other.txt']?.toString(), remote['secret.txt'].toString()]).toEqual(['pushed', 'theirs'])
  await volume.delete('secret.txt')
  await sync.run(true)
  expect(await text('secret.txt')).toBe('theirs')
  expect([sync.attention, commits.length]).toEqual([null, 1])
})

it('merges an edit of a local file GitHub just added too, now that GitHub tracks it', async () => {
  const { sync, write, text } = await setup({ 'notes.txt': 'kept', '.gitignore': 'secret.txt\n' })
  await write('secret.txt', 'mine\n')
  teammate({ 'secret.txt': 'theirs\n' })
  await sync.run()
  await write('secret.txt', 'mine, edited\n')
  await sync.run(true)
  expect(await text('secret.txt')).toContain('>>>>>>> GitHub')
  expect(sync.attention?.detail).toBe('secret.txt (conflict markers to resolve)')
  expect(remote['secret.txt'].toString()).toBe('theirs\n')
})

it('holds edits in a folder where GitHub now has a file, or at a file where it has a folder, and places them once the way is clear', async () => {
  const { sync, volume, write, text } = await setup({ 'notes.txt': 'kept' })
  await volume.mkdir('docs')
  await write('docs/new.md', 'draft')
  await write('plan', 'mine')
  teammate({ docs: 'a file now', 'plan/step': 'theirs', 'notes.txt': 'pulled' })
  await sync.run(true)
  expect([await text('notes.txt'), await text('docs/new.md'), await text('plan')]).toEqual(['pulled', 'draft', 'mine'])
  expect(Object.keys(remote).sort()).toEqual(['docs', 'notes.txt', 'plan/step'])
  expect(sync.attention?.detail?.split('\n').sort()).toEqual([
    'docs (a folder here, a file on GitHub)', 'docs/new.md (a folder here, a file on GitHub)',
    'plan (a file here, a folder on GitHub)', 'plan/step (a file here, a folder on GitHub)',
  ])
  await volume.delete('docs/new.md')
  await volume.delete('docs')
  await volume.delete('plan')
  await sync.run(true)
  expect([await text('docs'), await text('plan/step')]).toEqual(['a file now', 'theirs'])
  expect([sync.attention, commits]).toEqual([null, []])
})

it('holds a write onto a path GitHub tracks as a link', async () => {
  modes.set('link', '120000')
  archiveFiles = { 'notes.txt': Buffer.from('kept') }
  const { sync, write } = await setup({ 'notes.txt': 'kept', link: 'target' })
  await write('link', 'a file')
  await sync.run(true)
  expect(commits).toEqual([])
  expect(sync.attention?.detail).toContain('link (a link or submodule on GitHub)')
})

it('refuses to load unreadable edits instead of forgetting them', async () => {
  const { sync } = await setup(undefined, { start: false })
  await fs.mkdir(sync.folder, { recursive: true })
  await fs.writeFile(path.join(sync.folder, 'edits.json'), '{"version":1,')
  await expect(sync.loaded).rejects.toThrow()
})

it('holds both sides when a file moves twice into a workflow folder', async () => {
  const { volume, sync } = await setup({ 'a.txt': 'name: x\n' })
  await volume.mkdir('.github')
  await volume.mkdir('.github/workflows')
  await volume.move('a.txt', 'b.txt')
  await volume.move('b.txt', '.github/workflows/c.yml')
  await sync.run(true)
  expect([commits, Object.keys(remote)]).toEqual([[], ['a.txt']])
})

it("keeps a held file's GitHub version current when GitHub changes it and changes it back", async () => {
  const { sync, write } = await conflicted()
  teammate({ 'notes.txt': 'TEAM\ntwo\nlater\n' })
  await sync.run()
  teammate({ 'notes.txt': 'TEAM\ntwo\n' })
  await sync.run()
  await write('notes.txt', 'RESOLVED\ntwo\n')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('RESOLVED\ntwo\n')
})

it("stops pushing while the repo's .gitignore above a subfolder drive cannot be read", async () => {
  const { sync, write } = await setup({ '.gitignore': '.env\n', 'web/app.ts': 'app' }, { selected: 'web' })
  const blob = client.githubBlob.getMockImplementation()!
  client.githubBlob.mockImplementation(async (config, sha) => sha === blobSha(remote['.gitignore']) ? Promise.reject(new VolumeError('offline', 503)) : blob(config, sha))
  await write('.env', 'SECRET=1')
  await sync.run(true)
  expect(commits).toEqual([])
  expect(sync.attention).toMatchObject({ badge: { label: 'Sync paused' }, detail: expect.stringContaining('offline') })
})

it('does not keep checking GitHub for a drive whose only edits are held', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const { sync } = await conflicted()
    await vi.advanceTimersByTimeAsync(15_000)
    await sync.run()
    client.githubHead.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.githubHead).not.toHaveBeenCalled()
    expect(sync.unpushed).toBe(1)
  } finally { vi.useRealTimers() }
})

it('refuses to move a file with a conflict until it is resolved', async () => {
  const { volume, write, marked } = await conflicted()
  await expect(volume.move('other.txt', 'notes.txt')).rejects.toMatchObject({ code: 'not-accessible' })
  await expect(volume.move('notes.txt', 'moved.txt')).rejects.toMatchObject({ code: 'not-accessible', message: 'notes.txt has a conflict with GitHub. Resolve it before moving it.' })
  await write('notes.txt', marked.replace(/<<<<<<< Agent's version\n|=======\n|>>>>>>> .*\n/g, ''))
  await volume.move('notes.txt', 'moved.txt')
})

it('keeps a version a merge may need on disk, not in memory, and drops it once GitHub has it', async () => {
  const { sync, write } = await setup({ 'notes.txt': 'one\n' })
  await write('notes.txt', 'two\n')
  const versions = path.join(sync.folder, 'versions')
  expect(await fs.readdir(versions)).toEqual([blobSha(Buffer.from('two\n'))])
  await sync.run(true)
  await backgroundSettled()
  expect(await fs.readdir(versions)).toEqual([])
  expect(Object.values(sync).some(value => value instanceof Map && [...value.values()].some(item => Buffer.isBuffer(item)))).toBe(false)
})

it('serves an unsynced file too large to push without reading it whole', async () => {
  const { volume, write } = await setup()
  await write('big.bin', 'x'.repeat(800_000))
  const readFile = vi.spyOn(fs, 'readFile')
  for (let i = 0; i < 3; i++) {
    const file = await volume.read('big.bin')
    expect(await new Response(await file.stream({ start: 0, end: 4 })).text()).toBe('xxxxx')
    await file.close?.()
  }
  expect(readFile.mock.calls.filter(([target]) => String(target).endsWith('big.bin'))).toEqual([])
})

it('keeps an upload too large to push local, and says so', async () => {
  const { sync, write } = await setup()
  await write('big.bin', 'x'.repeat(800_000))
  await sync.run(true)
  expect([commits, sync.unpushed]).toEqual([[], 1])
  expect(sync.attention?.detail).toContain('big.bin (over the size limit)')
})

it('records the cause when every retry of a push loses its reply', async () => {
  const { sync, write } = await setup()
  await write('notes.txt', 'edited')
  client.githubCommit.mockRejectedValue(new VolumeError('GitHub is temporarily unavailable. Please try again.', 503))
  await sync.run(true)
  expect(client.githubCommit).toHaveBeenCalledTimes(3)
  expect(sync.attention).toMatchObject({ badge: { label: 'Sync paused' }, detail: expect.stringContaining('GitHub is temporarily unavailable. Please try again.') })
})

/** A teammate's commit moves the branch. */
function teammate(changes: Record<string, string | null>) {
  for (const [name, value] of Object.entries(changes)) {
    if (remote[name]) history.push(remote[name])
    if (value === null) delete remote[name]
    else remote[name] = Buffer.from(value)
  }
  head = String(history.length + commits.length + 1).padStart(40, 'd')
}

it('keeps a change merged into a write when the same mount writes again from the bytes it sent', async () => {
  const { sync, write, text } = await setup({ 'notes.txt': 'a\n1\nb\n2\nc\n' })
  await text('notes.txt')
  teammate({ 'notes.txt': 'a\n1\nb\n2\nC\n' })
  await sync.run()
  await write('notes.txt', 'A\n1\nb\n2\nc\n')
  await write('notes.txt', 'A\n1\nB\n2\nc\n')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('A\n1\nB\n2\nC\n')
})

it('merges two mounts of one drive, and takes a replayed upload as already applied', async () => {
  const { volume, row, sync } = await setup({ 'notes.txt': 'a\n1\nb\n2\nc\n' })
  const other = new GithubMountableVolume('mount-2', row.name, row.config, row.id, 'other')
  const put = (mount: GithubMountableVolume, text: string) => mount.write('notes.txt', new Blob([text]).stream())
  for (const mount of [volume, other]) await new Response(await (await mount.read('notes.txt')).stream()).text()
  await put(other, 'a\n1\nb\n2\nC\n')
  await put(volume, 'A\n1\nb\n2\nc\n')
  await put(volume, 'A\n1\nb\n2\nc\n')
  await put(volume, 'A\n1\nB\n2\nc\n')
  await sync.run(true)
  expect(remote['notes.txt'].toString()).toBe('A\n1\nB\n2\nC\n')
  expect(commits).toHaveLength(1)
})

it('keeps a conflict held when the upload that made it is replayed', async () => {
  const { sync, write, text } = await setup({ 'notes.txt': 'one\ntwo\n' })
  await text('notes.txt')
  teammate({ 'notes.txt': 'TEAM\ntwo\n' })
  await sync.run()
  await write('notes.txt', 'AGENT\ntwo\n')
  await write('notes.txt', 'AGENT\ntwo\n')
  await sync.run(true)
  expect([commits, remote['notes.txt'].toString()]).toEqual([[], 'TEAM\ntwo\n'])
  expect(sync.attention?.detail).toContain('notes.txt (conflict markers to resolve)')
})

it('pushes a drive written to without pause two minutes after its first unpushed write', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    const { write, sync } = await setup()
    for (let second = 0; second < 115; second += 5) {
      await write('notes.txt', `edit ${second}`)
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(commits).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    await sync.run()
    expect(remote['notes.txt'].toString()).toBe('edit 110')
  } finally { vi.useRealTimers() }
})
