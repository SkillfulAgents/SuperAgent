import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { PNG } from 'pngjs'
import * as schema from '../db/schema'

let testSqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle<typeof schema>>
let dataDir: string

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
}))

import { avatarDirectory, setAvatar } from './profile-avatar-service'

const { user } = schema
const USER = 'user-1'

function png(shade: number): Buffer {
  const image = new PNG({ width: 2, height: 2 })
  image.data.fill(shade)
  return PNG.sync.write(image)
}

function storedFiles(): string[] {
  return fs.existsSync(avatarDirectory()) ? fs.readdirSync(avatarDirectory()).sort() : []
}

function override(): string | null {
  return testDb.select({ avatar: user.avatarOverride }).from(user).where(eq(user.id, USER)).get()?.avatar ?? null
}

function fileOf(reference: string | null): string {
  return path.basename(reference ?? '')
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-swap-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  testSqlite = new Database(':memory:')
  testDb = drizzle(testSqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  testDb.insert(user).values({ id: USER, name: 'One', email: 'one@example.test' }).run()
})

afterEach(() => {
  vi.unstubAllEnvs()
  testSqlite.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('setAvatar', () => {
  it('stores the photo, then replaces it and unlinks the previous file', async () => {
    const first = await setAvatar(USER, png(10))
    expect(override()).toBe(first)
    expect(storedFiles()).toEqual([fileOf(first)])

    const second = await setAvatar(USER, png(20))
    expect(override()).toBe(second)
    expect(storedFiles()).toEqual([fileOf(second)])

    expect(await setAvatar(USER, null)).toBeNull()
    expect(override()).toBeNull()
    expect(storedFiles()).toEqual([])
  })

  it('unlinks the new file and throws when the user is gone', async () => {
    testDb.delete(user).where(eq(user.id, USER)).run()
    await expect(setAvatar(USER, png(10))).rejects.toThrow('User no longer exists')
    expect(storedFiles()).toEqual([])
  })

  it('two windows uploading at once each unlink only the file they displaced', async () => {
    // Each swap is a compare-and-set against the value it read, so exactly
    // one file survives on disk and it is the one the row points at.
    const before = await setAvatar(USER, png(1))
    const [a, b] = await Promise.all([setAvatar(USER, png(2)), setAvatar(USER, png(3))])

    expect(storedFiles()).toEqual([fileOf(override())])
    expect([a, b]).toContain(override())
    expect(storedFiles()).not.toContain(fileOf(before))
  })
})
