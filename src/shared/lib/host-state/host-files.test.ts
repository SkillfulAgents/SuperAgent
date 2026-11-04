import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { openJson, resetVaultKeyCache, sealJson } from '@shared/lib/browser-vault/vault-crypto'
import { getOrCreateHostToken } from '@shared/lib/container/host-token-store'
import { dataDirHostFiles, setHostFileStore, type HostFileStore } from './host-files'
import { singletonHostFiles } from './singletons'

/** Host files kept somewhere other than the data dir, as a deployment's store would. */
class InMemoryHostFiles implements HostFileStore {
  files = new Map<string, string>()
  private memos = new Map<string, unknown>()

  read(name: string) {
    return this.files.get(name) ?? null
  }
  write(name: string, update: (current: string | null) => string) {
    const next = update(this.read(name))
    this.files.set(name, next)
    this.memos.delete(name)
    return next
  }
  replace(name: string, text: string) {
    this.files.set(name, text)
    this.memos.delete(name)
  }
  singleton(name: string) {
    if (!this.files.has(name)) this.files.set(name, singletonHostFiles().get(name)!())
    return this.files.get(name)!
  }
  memo<T>(name: string, load: () => T): T {
    if (!this.memos.has(name)) this.memos.set(name, load())
    return this.memos.get(name) as T
  }
  remember<T>(name: string, value: T) {
    this.memos.set(name, value)
  }
  forget(name: string) {
    this.memos.delete(name)
  }
  async flush() {}
}

let dataDir: string
let store: InMemoryHostFiles

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-files-test-'))
  process.env.SUPERAGENT_DATA_DIR = dataDir
  store = new InMemoryHostFiles()
  setHostFileStore(store)
  resetVaultKeyCache()
})

afterEach(() => {
  setHostFileStore(dataDirHostFiles)
  resetVaultKeyCache()
  delete process.env.SUPERAGENT_DATA_DIR
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('setHostFileStore', () => {
  it('keeps the tenant id, the vault key and host tokens in the installed store, not the data dir', () => {
    const tenantId = getTenantId()
    expect(store.files.get('tenant-id')).toBe(tenantId)
    expect(getTenantId()).toBe(tenantId)

    const binding = { purpose: 'account-secrets' as const, id: 'account-1', site: 'github.com' }
    const sealed = sealJson({ password: 'hunter2' }, binding, z.object({ password: z.string() }))
    expect(store.files.has('.vault-key')).toBe(true)
    expect(openJson(sealed, binding, z.object({ password: z.string() }))).toEqual({ password: 'hunter2' })

    const token = getOrCreateHostToken('sales-assistant')
    expect(JSON.parse(store.files.get('host-container-tokens.json')!)).toEqual({ 'sales-assistant': token })
    expect(getOrCreateHostToken('sales-assistant')).toBe(token)

    expect(fs.readdirSync(dataDir)).toEqual([])
  })
})
