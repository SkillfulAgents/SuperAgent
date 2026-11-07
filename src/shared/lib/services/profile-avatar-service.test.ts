import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
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

import { inflatedSizeUpTo, InvalidAvatarError, prepareAvatar, setAvatar } from './profile-avatar-service'

const { user } = schema
const USER = 'user-1'

function png(shade: number): Buffer {
  const image = new PNG({ width: 2, height: 2 })
  image.data.fill(shade)
  return PNG.sync.write(image)
}

function storedFiles(): string[] {
  const dir = path.join(dataDir, 'profile-photos')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
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

describe('prepareAvatar', () => {
  /** A PNG chunk with its length and CRC. */
  function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }

  it('re-encodes a valid photo', () => {
    const decoded = PNG.sync.read(prepareAvatar(png(30)))
    expect([decoded.width, decoded.height, decoded.data[0]]).toEqual([2, 2, 30])
  })

  it('rejects image data that inflates past the size its header gives', () => {
    const header = png(30).subarray(8, 33)
    // 2 × 2 RGBA needs 18 bytes; this stream inflates to 1 MB.
    const oversized = zlib.deflateSync(Buffer.alloc(1024 * 1024))
    const input = Buffer.concat([png(30).subarray(0, 8), header, chunk('IDAT', oversized), chunk('IEND', Buffer.alloc(0))])

    expect(() => prepareAvatar(input)).toThrow(InvalidAvatarError)
  })

  it('stops inflating soon after the data passes the size the header gives', () => {
    // 16 KB of deflate data that inflates to 16 MB.
    const bomb = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024), { level: 9 })

    expect(inflatedSizeUpTo(bomb, 18)).toBeLessThan(2 * 1024 * 1024)
    expect(inflatedSizeUpTo(zlib.deflateSync(Buffer.alloc(18)), 18)).toBe(18)
  })
})
