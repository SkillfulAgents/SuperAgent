import { describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { FakeSealedData, memoryLog } from '@shared/lib/keys/testing/fake-probe'
import { CloudflareKeyManager } from './cloudflare-key-manager'

const SECRET = Buffer.alloc(32, 7)

function keyManager(secret: string | undefined, sealed = new FakeSealedData()) {
  return new CloudflareKeyManager({ env: { SUPERAGENT_VAULT_KEY: secret }, probes: sealed.probes, log: memoryLog() })
}

describe('CloudflareKeyManager', () => {
  it('reads the key from the Worker secret', async () => {
    const sealed = new FakeSealedData()
    sealed.sealedUnder = SECRET

    const key = await keyManager(SECRET.toString('base64'), sealed).key('browser-vault')

    expect(key.export()).toEqual(SECRET)
  })

  it('never makes a key when the secret is missing', async () => {
    const keys = keyManager(undefined)
    await keys.initialize()

    await expect(keys.key('browser-vault')).rejects.toMatchObject({ reason: 'missing' })
  })

  it('refuses a secret that does not open the saved logins', async () => {
    const sealed = new FakeSealedData()
    sealed.sealedUnder = Buffer.alloc(32, 1)

    await expect(keyManager(SECRET.toString('base64'), sealed).key('browser-vault')).rejects.toMatchObject({ reason: 'mismatch' })
  })

  it('reads nothing when it is installed, and checks the key before its first use', async () => {
    const sealed = new FakeSealedData()
    sealed.sealedUnder = SECRET
    const probe = vi.fn(sealed.probes['browser-vault'])
    const keys = new CloudflareKeyManager({ env: { SUPERAGENT_VAULT_KEY: SECRET.toString('base64') }, probes: { ...sealed.probes, 'browser-vault': probe }, log: memoryLog() })

    await keys.initialize()
    expect(probe).not.toHaveBeenCalled()

    await keys.key('browser-vault')
    await keys.key('browser-vault')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reports a secret that does not open the saved logins when a deploy checks it', async () => {
    const sealed = new FakeSealedData()
    sealed.sealedUnder = Buffer.alloc(32, 1)
    const log = memoryLog()
    const keys = new CloudflareKeyManager({ env: { SUPERAGENT_VAULT_KEY: SECRET.toString('base64') }, probes: sealed.probes, log })

    await keys.check()

    expect(JSON.stringify(log)).toContain('mismatch')
    await expect(keys.key('browser-vault')).rejects.toMatchObject({ reason: 'mismatch' })
  })

  it('refuses a secret that is not a key', async () => {
    await expect(keyManager('not a key').key('browser-vault')).rejects.toMatchObject({ reason: 'misconfigured' })
  })
})
