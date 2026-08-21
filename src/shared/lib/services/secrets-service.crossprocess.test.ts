/**
 * Cross-implementation interop for the agent .env: the host's setSecret
 * (withCrossProcessFileLock + writeFileAtomic) and the agent-container's
 * updateEnvFileEntry (withEnvFileLock + its own writeFileAtomic) write the SAME
 * bind-mounted file from different processes. The two lock implementations are
 * intentionally protocol-compatible (`<target>.lock`, O_EXCL, stale-steal) —
 * this suite is the only place that runs them against each other, modeling the
 * exact prod collision that wiped /workspace/.env: the provide-secret route
 * calls host setSecret and container POST /env back-to-back.
 *
 * Deliberately imports container code into a host test (the dependency rule
 * only forbids agent-container importing @shared, not the reverse).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { updateEnvFileEntry } from '../../../../agent-container/src/env-file-store'

let tmpDir: string

function envPath(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'workspace', '.env')
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-xproc-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
})

async function importService() {
  return import('./secrets-service')
}

describe('host setSecret ↔ container updateEnvFileEntry interop', () => {
  it('the provide-secret sequence (host write, then container write) keeps every secret', async () => {
    // The exact prod sequence that wiped the file: host merges the new secret
    // into .env, then the container's POST /env upserts the same key again.
    const { setSecret, listSecrets } = await importService()
    await setSecret('agent', { envVar: 'SUPABASE_URL', key: 'SUPABASE_URL', value: 'https://x' })
    await setSecret('agent', { envVar: 'STRIPE_KEY', key: 'Stripe Key', value: 'sk-1' })

    await setSecret('agent', { envVar: 'APOLLO_API_KEY', key: 'APOLLO_API_KEY', value: 'tok' })
    await updateEnvFileEntry(envPath('agent'), 'APOLLO_API_KEY', 'tok')

    const secrets = await listSecrets('agent')
    const byVar = new Map(secrets.map((s) => [s.envVar, s]))
    expect(byVar.get('SUPABASE_URL')?.value).toBe('https://x')
    expect(byVar.get('STRIPE_KEY')?.value).toBe('sk-1')
    expect(byVar.get('APOLLO_API_KEY')?.value).toBe('tok')
    // The container's rewrite preserved the host's display-name comment.
    expect(byVar.get('STRIPE_KEY')?.key).toBe('Stripe Key')
    // And the host header survived the container write.
    expect(fs.readFileSync(envPath('agent'), 'utf-8')).toMatch(/^# Superagent Secrets/)
  })

  it('interleaved host and container writers never lose a key', { timeout: 30_000 }, async () => {
    const { setSecret, listSecrets } = await importService()
    // Seed so the workspace dir + file exist before the storm.
    await setSecret('agent', { envVar: 'SEED', key: 'Seed Secret', value: 'seed' })

    const hostWrites = Array.from({ length: 10 }, (_, i) =>
      setSecret('agent', { envVar: `HOST_${i}`, key: `HOST_${i}`, value: `h${i}` })
    )
    const containerWrites = Array.from({ length: 10 }, (_, i) =>
      updateEnvFileEntry(envPath('agent'), `CONTAINER_${i}`, `c${i}`)
    )
    await Promise.all([...hostWrites, ...containerWrites])

    const secrets = await listSecrets('agent')
    const byVar = new Map(secrets.map((s) => [s.envVar, s.value]))
    expect(byVar.get('SEED')).toBe('seed')
    for (let i = 0; i < 10; i++) {
      expect(byVar.get(`HOST_${i}`)).toBe(`h${i}`)
      expect(byVar.get(`CONTAINER_${i}`)).toBe(`c${i}`)
    }
    expect(secrets).toHaveLength(21)
    // No stray lock or temp files once the dust settles.
    const dir = path.dirname(envPath('agent'))
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))
    expect(stray).toEqual([])
  })

  it('a container write between two host writes round-trips values with special characters', async () => {
    const { setSecret, listSecrets } = await importService()
    await setSecret('agent', { envVar: 'JSONISH', key: 'JSONISH', value: '{"a": "b c", "n": 1}' })

    await updateEnvFileEntry(envPath('agent'), 'CONNECTED_ACCOUNTS', '{"github": [{"name": "x"}]}')
    await setSecret('agent', { envVar: 'AFTER', key: 'AFTER', value: 'v' })

    const byVar = new Map((await listSecrets('agent')).map((s) => [s.envVar, s.value]))
    expect(byVar.get('JSONISH')).toBe('{"a": "b c", "n": 1}')
    expect(byVar.get('CONNECTED_ACCOUNTS')).toBe('{"github": [{"name": "x"}]}')
    expect(byVar.get('AFTER')).toBe('v')
  })
})
