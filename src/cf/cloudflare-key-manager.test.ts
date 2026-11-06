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

  it('refuses a secret that is not a key', async () => {
    await expect(keyManager('not a key').key('browser-vault')).rejects.toMatchObject({ reason: 'misconfigured' })
  })
})
