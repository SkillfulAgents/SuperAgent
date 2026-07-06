/**
 * Agent `.env` secrets: serialized (cross-process-aware) + atomic
 * writes so an interleaved or interrupted read-modify-write can't drop other
 * secrets or truncate the file (which doubles as the container runtime env).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

function envPath(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'workspace', '.env')
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
})

async function importService() {
  return import('./secrets-service')
}

describe('serialized .env writes (no lost secrets)', () => {
  it('many concurrent setSecret calls with distinct keys ALL survive', async () => {
    const { setSecret, listSecrets } = await importService()
    const keys = Array.from({ length: 30 }, (_, i) => `KEY_${i}`)

    await Promise.all(
      keys.map((k) => setSecret('agent', { envVar: k, key: k, value: `val-${k}` }))
    )

    const secrets = await listSecrets('agent')
    const got = new Map(secrets.map((s) => [s.envVar, s.value]))
    for (const k of keys) expect(got.get(k)).toBe(`val-${k}`)
    expect(secrets).toHaveLength(keys.length)
  })

  it('concurrent set + delete on different keys do not clobber each other', async () => {
    const { setSecret, deleteSecret, listSecrets } = await importService()
    // Seed two secrets.
    await setSecret('agent', { envVar: 'KEEP', key: 'KEEP', value: 'keep' })
    await setSecret('agent', { envVar: 'DROP', key: 'DROP', value: 'drop' })

    await Promise.all([
      setSecret('agent', { envVar: 'NEW', key: 'NEW', value: 'new' }),
      deleteSecret('agent', 'DROP'),
    ])

    const envVars = (await listSecrets('agent')).map((s) => s.envVar).sort()
    expect(envVars).toEqual(['KEEP', 'NEW'])
  })
})

describe('atomic .env writes', () => {
  it('setSecret leaves no temp/lock file behind and writes a parseable file', async () => {
    const { setSecret, listSecrets } = await importService()
    await setSecret('agent', { envVar: 'API_KEY', key: 'My API Key', value: 'sk-123' })

    const dir = path.dirname(envPath('agent'))
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))
    expect(stray).toEqual([])

    const secrets = await listSecrets('agent')
    expect(secrets).toHaveLength(1)
    expect(secrets[0]).toMatchObject({ envVar: 'API_KEY', value: 'sk-123' })
  })

  it.runIf(process.platform !== 'win32')('creates the .env world-writable (exact 0o666) so the container — a different uid — can write it', async () => {
    const { setSecret } = await importService()
    await setSecret('agent', { envVar: 'X', key: 'X', value: '1' })
    expect(fs.statSync(envPath('agent')).mode & 0o777).toBe(0o666)
  })

  it.runIf(process.platform !== 'win32')('heals a .env stuck at 0o600 back to 0o666 on the next write', async () => {
    // The atomic rename transfers ownership to this process; if it also
    // preserved a stray 0o600 (left by the old container create-mode), the
    // container could no longer even READ the file — its next POST /env would
    // fail with EACCES (or, before the fail-closed fix, wipe the file).
    const { setSecret } = await importService()
    await setSecret('agent', { envVar: 'A', key: 'A', value: '1' })
    fs.chmodSync(envPath('agent'), 0o600)

    await setSecret('agent', { envVar: 'B', key: 'B', value: '2' })

    expect(fs.statSync(envPath('agent')).mode & 0o777).toBe(0o666)
  })

  it('deleteSecret returns false and writes nothing for an unknown key', async () => {
    const { setSecret, deleteSecret } = await importService()
    await setSecret('agent', { envVar: 'A', key: 'A', value: '1' })
    const before = fs.readFileSync(envPath('agent'), 'utf-8')

    expect(await deleteSecret('agent', 'NOPE')).toBe(false)
    expect(fs.readFileSync(envPath('agent'), 'utf-8')).toBe(before)
  })

  it('setSecret fails closed when the .env is unreadable — never rewrites from an empty view', async () => {
    // If the under-lock re-read errors (NFS ESTALE, EIO — anything but a true
    // ENOENT), setSecret must abort, NOT treat the file as empty: merging into
    // "empty" and writing back atomically wipes every other secret.
    const { setSecret } = await importService()
    await setSecret('agent', { envVar: 'SUPABASE_URL', key: 'SUPABASE_URL', value: 'https://x' })
    await setSecret('agent', { envVar: 'STRIPE_KEY', key: 'STRIPE_KEY', value: 'sk-1' })
    const before = fs.readFileSync(envPath('agent'), 'utf-8')

    const realReadFile = fs.promises.readFile.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (
      p: unknown,
      ...args: unknown[]
    ) => {
      if (typeof p === 'string' && p.endsWith(path.join('workspace', '.env'))) {
        throw Object.assign(new Error('ESTALE: stale file handle'), { code: 'ESTALE' })
      }
      return (realReadFile as any)(p, ...args)
    }) as typeof fs.promises.readFile)

    try {
      await expect(
        setSecret('agent', { envVar: 'NEW', key: 'NEW', value: 'v' })
      ).rejects.toMatchObject({ code: 'ESTALE' })
    } finally {
      spy.mockRestore()
    }

    expect(fs.readFileSync(envPath('agent'), 'utf-8')).toBe(before)
  })

  it('deleteSecret returns false (does NOT throw) when the workspace/.env is absent', async () => {
    // The agent's workspace dir doesn't exist, so opening the cross-process
    // lockfile would ENOENT. deleteSecret must short-circuit to false (→ route
    // 404) instead of letting the ENOENT bubble up (→ route 500).
    const { deleteSecret } = await importService()
    expect(fs.existsSync(path.dirname(envPath('ghost-agent')))).toBe(false)
    await expect(deleteSecret('ghost-agent', 'ANY_VAR')).resolves.toBe(false)
    // And it didn't create the workspace dir or a stray lockfile as a side effect.
    expect(fs.existsSync(path.dirname(envPath('ghost-agent')))).toBe(false)
  })
})
