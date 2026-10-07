/**
 * The app's volume list, the real Docker client and the agent image, end to end.
 * Opt-in, needs Docker Desktop, builds the image first:
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
  getActiveLlmProvider: () => ({ getContainerEnvVars: async () => ({}), toolSearchEnv: undefined }),
}))
vi.mock('@shared/lib/platform-attribution/container-token', () => ({ getPlatformContainerToken: async () => undefined }))

import { addMount, listVolumes } from '@shared/lib/services/mount-service'
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
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
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
})
