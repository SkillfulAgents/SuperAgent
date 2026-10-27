/**
 * The app's volume list, the real Docker client and the agent image, end to end.
 * Opt-in, needs Docker (Desktop, or native Linux), builds the image first:
 *   RUN_VOLUMES_E2E=1 npx vitest run src/shared/lib/volumes/volumes.e2e.test.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { execFile, execFileSync, spawnSync } from 'child_process'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents } from '@shared/lib/db/schema'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
import { serve, type ServerType } from '@hono/node-server'

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => (token === 'test-token' ? 'agent-a' : null),
}))
// The agent's LLM and platform credentials are not under test.
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: async () => ({}), toolSearchEnv: () => 'false' }),
}))
vi.mock('@shared/lib/platform-attribution/container-token', () => ({ getPlatformContainerToken: async () => undefined }))
// A GitHub repository in memory: the drive's merges and rclone's checks are under test, not GitHub's API.
const github = vi.hoisted(() => ({ files: {} as Record<string, Buffer>, head: 'a'.repeat(40) }))
vi.mock('@shared/lib/volumes/github-client', async () => {
  const { blobSha } = await import('@shared/lib/volumes/github-sync-state')
  return {
    requireGithubAccount: async () => ({}),
    githubRepos: async () => [], githubBranches: async () => [], githubFolder: async () => [], githubTarball: async () => new Response(null),
    githubRepo: async () => ({ id: 1, name: 'project', owner: { login: 'team' } }),
    githubHead: async () => github.head,
    githubTree: async () => Object.entries(github.files).map(([name, bytes]) => ({ path: name, sha: blobSha(bytes), mode: '100644', type: 'blob', size: bytes.length })),
    githubBlob: async (_config: unknown, sha: string) => Object.values(github.files).find(bytes => blobSha(bytes) === sha),
    githubCommit: async (_config: unknown, _expected: string, changes: { path: string; contents: Buffer | null }[]) => {
      for (const change of changes) {
        if (change.contents) github.files[change.path] = change.contents
        else delete github.files[change.path]
      }
      return github.head = github.head.replace(/^./, c => String((Number.parseInt(c, 16) + 1) % 16))
    },
  }
})

import { addMount, listVolumes, setMountReadOnly } from '@shared/lib/services/mount-service'
import { GithubMountableVolume } from '@shared/lib/volumes/github-mountable-volume'
import { removeGithubSync } from '@shared/lib/volumes/github-sync'
import { DockerContainerClient } from '@shared/lib/container/docker-container-client'
import volumes from '../../../api/routes/volumes'

const ENABLED = process.env.RUN_VOLUMES_E2E === '1'
const IMAGE = 'superagent-volumes-e2e'

// Async, so this process keeps serving the route while the container reads through it.
async function docker(...args: string[]): Promise<string> {
  return (await promisify(execFile)('docker', args, { encoding: 'utf8', timeout: 60_000 })).stdout.trim()
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`not true within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe.skipIf(!ENABLED)('client folders as volumes, from the list to the mount', () => {
  let tmpDir: string
  let server: ServerType
  const client = () => new DockerContainerClient({ agentId: 'agent-a' } as never)

  beforeAll(async () => {
    handle = await createTestDatabase()
    await handle.db.insert(agents).values({ slug: 'agent-a', name: 'Agent A', createdAt: new Date() }).run()
    execFileSync('docker', ['build', '-t', IMAGE, path.resolve(__dirname, '../../../../agent-container')], { stdio: 'ignore', timeout: 900_000 })
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volumes-e2e-')))
    process.env.SUPERAGENT_DATA_DIR = tmpDir
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ container: { agentImage: IMAGE } }))
    const app = new Hono()
    app.route('/api/volumes', volumes)
    // Native Linux containers reach the host through docker0, not its loopback.
    server = serve({ fetch: app.fetch, port: 0, hostname: client().getHostBridgeIp() ?? '127.0.0.1' })
  }, 900_000)

  afterAll(async () => {
    await handle?.close()
    spawnSync('docker', ['rm', '-f', 'superagent-agent-a'], { stdio: 'ignore', timeout: 60_000 })
    server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  }, 60_000)

  it('mounts the listed folders, leaves out a missing one, and reports one that vanished as unmounted', async () => {
    const folder = (name: string) => {
      fs.mkdirSync(path.join(tmpDir, name))
      return path.join(tmpDir, name)
    }
    const notes = folder('notes')
    fs.writeFileSync(path.join(notes, 'a.txt'), 'hello')
    const { id: notesId } = await addMount('agent-a', 'local', { path: notes }, { userId: null, admin: true })
    await addMount('agent-a', 'local', { path: folder('late') }, { userId: null, admin: true })
    await addMount('agent-a', 'local', { path: folder('gone') }, { userId: null, admin: true })
    fs.rmSync(path.join(tmpDir, 'gone'), { recursive: true })

    const listed = await listVolumes('agent-a')
    expect(listed.notMounted).toEqual([{ name: 'gone', reason: 'not found' }])
    expect(listed.volumes.map((v) => v.name)).toEqual(['notes', 'late'])
    // Vanishes between the start's list and the container's mount.
    fs.rmSync(path.join(tmpDir, 'late'), { recursive: true })

    const { port } = server.address() as AddressInfo
    const started = await client().start({
      envVars: { SUPERAGENT_HOST_API_URL: `http://host.docker.internal:${port}/api`, PROXY_TOKEN: 'test-token' },
      volumes: listed.volumes,
    })
    expect(await client().health(started.port ?? undefined)).toMatchObject({ status: 'ok', volumes: [notesId] })

    // As claude, who owns the FUSE mounts.
    const sh = (script: string) => docker('exec', '--user', 'claude', 'superagent-agent-a', 'bash', '-c', script)
    expect(await sh('mountpoint -q /mounts/late && echo mounted || echo unmounted')).toBe('unmounted')
    expect(await sh('cat /mounts/notes/a.txt')).toBe('hello')
    await sh('echo new > /mounts/notes/b.txt')
    await waitFor(() => fs.existsSync(path.join(notes, 'b.txt')) && fs.readFileSync(path.join(notes, 'b.txt'), 'utf8') === 'new\n', 5_000)
  }, 180_000)

  it('mounts a read-only volume that reads, and refuses writes through the mount and straight to the host', async () => {
    const docs = path.join(tmpDir, 'docs')
    fs.mkdirSync(docs)
    fs.writeFileSync(path.join(docs, 'a.txt'), 'hello')
    const { id } = await addMount('agent-a', 'local', { path: docs }, { userId: null, admin: true })
    await setMountReadOnly('agent-a', id, true)

    await client().stop()
    const { port } = server.address() as AddressInfo
    const hostApiUrl = `http://host.docker.internal:${port}/api`
    const started = await client().start({
      envVars: { SUPERAGENT_HOST_API_URL: hostApiUrl, PROXY_TOKEN: 'test-token' },
      volumes: (await listVolumes('agent-a')).volumes,
    })
    expect(await client().health(started.port ?? undefined)).toMatchObject({ status: 'ok' })

    const sh = (script: string) => docker('exec', '--user', 'claude', 'superagent-agent-a', 'bash', '-c', script)
    expect(await sh('cat /mounts/docs/a.txt')).toBe('hello')
    expect(await sh('(echo x > /mounts/docs/b.txt) 2>&1 || true')).toContain('Read-only file system')
    expect(await sh(`curl -s -o /dev/null -w '%{http_code}' -X PUT --data x -H 'Authorization: Bearer test-token' ${hostApiUrl}/volumes/${id}/b.txt`)).toBe('403')
    expect(fs.readdirSync(docs)).toEqual(['a.txt'])
  }, 180_000)

  it('keeps a GitHub drive merge that a stale write met, and shows the writer the merged file', async () => {
    const lines = (edit: Record<number, string> = {}) => Array.from({ length: 10 }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join('')
    github.files = { 'notes.txt': Buffer.from(lines()) }
    const config = { accountId: 'account', repoId: 1, owner: 'team', repo: 'project', branch: 'main', path: '' }
    const { volumeId } = await addMount('agent-a', 'github', config, { userId: null, admin: true })
    await client().stop()
    const { port } = server.address() as AddressInfo
    await client().start({
      envVars: { SUPERAGENT_HOST_API_URL: `http://host.docker.internal:${port}/api`, PROXY_TOKEN: 'test-token' },
      volumes: (await listVolumes('agent-a')).volumes,
    })
    const sh = (script: string) => docker('exec', '--user', 'claude', 'superagent-agent-a', 'bash', '-c', script)
    const copy = path.join(tmpDir, 'volumes', volumeId, 'copy', 'notes.txt')
    try {
      expect(await sh('cat /mounts/project/notes.txt')).toBe(lines().trimEnd())
      // Another agent's mount of the drive changes line 2 after this one read the file.
      const other = new GithubMountableVolume('other-mount', 'project', config, volumeId, 'agent-b')
      await new Response(await (await other.read('notes.txt')).stream()).text()
      await other.write('notes.txt', new Blob([lines({ 2: 'line 2 from b' })]).stream())
      // This agent writes its edit of what it read, and the merge stores a file of another size than it sent.
      await sh(`printf '${lines({ 8: 'line 8 from a, longer' })}' > /mounts/project/notes.txt`)
      const merged = lines({ 2: 'line 2 from b', 8: 'line 8 from a, longer' })
      await waitFor(() => fs.readFileSync(copy, 'utf8') === merged, 10_000)
      // rclone, seeing another size than it sent, used to delete the file and send its bytes again.
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(fs.readFileSync(copy, 'utf8')).toBe(merged)
      await waitFor(async () => (await sh('cat /mounts/project/notes.txt')) === merged.trimEnd(), 10_000)

      // Again, and this time the agent renames the file before opening it: rclone takes the new path's entry as its bytes.
      await new Response(await (await other.read('notes.txt')).stream()).text()
      await other.write('notes.txt', new Blob([lines({ 2: 'line 2 from b', 3: 'line 3 from b', 8: 'line 8 from a, longer' })]).stream())
      await sh(`printf '${lines({ 2: 'line 2 from b', 8: 'line 8 from a, longer', 9: 'line 9 from a' })}' > /mounts/project/notes.txt`)
      const again = lines({ 2: 'line 2 from b', 3: 'line 3 from b', 8: 'line 8 from a, longer', 9: 'line 9 from a' })
      await waitFor(() => fs.readFileSync(copy, 'utf8') === again, 10_000)
      await sh('mv /mounts/project/notes.txt /mounts/project/moved.txt')
      await waitFor(async () => (await sh('cat /mounts/project/moved.txt')) === again.trimEnd(), 10_000)
    } finally {
      await removeGithubSync(volumeId)
    }
  }, 180_000)
})
