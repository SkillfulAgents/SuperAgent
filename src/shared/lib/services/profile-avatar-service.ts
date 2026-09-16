import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { user } from '@shared/lib/db/schema'
import { getDataDir } from '@shared/lib/config/data-dir'
import { avatarOverrideSchema, MAX_AVATAR_BYTES } from '@shared/lib/user-profile-schema'

export class InvalidAvatarError extends Error {}
const MAX_DIMENSION = 512

/** Decode and re-encode a bounded raster: don't persist untrusted ancillary data. */
export function prepareAvatar(input: Buffer): Buffer {
  if (input.length < 33 || input.length > MAX_AVATAR_BYTES
    || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || input.toString('ascii', 12, 16) !== 'IHDR') {
    throw new InvalidAvatarError('Choose a PNG image under 1 MB.')
  }
  // pngjs bounds inflation for non-interlaced images. Canvas uploads use this
  // form; reject interlacing and a second IHDR before the decoder can allocate.
  if (input.readUInt32BE(8) !== 13 || input[28] !== 0) {
    throw new InvalidAvatarError('Choose a standard, non-interlaced PNG image.')
  }
  for (let offset = 8; offset < input.length;) {
    if (offset + 12 > input.length) throw new InvalidAvatarError('Incomplete PNG image.')
    const length = input.readUInt32BE(offset)
    if (length > input.length - offset - 12
      || (offset !== 8 && input.toString('ascii', offset + 4, offset + 8) === 'IHDR')) {
      throw new InvalidAvatarError('Invalid PNG image.')
    }
    offset += length + 12
  }
  const width = input.readUInt32BE(16)
  const height = input.readUInt32BE(20)
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new InvalidAvatarError('Photo dimensions must be at most 512 × 512 pixels.')
  }
  try {
    const decoded = PNG.sync.read(input, { checkCRC: true })
    const clean = new PNG({ width: decoded.width, height: decoded.height })
    clean.data = decoded.data
    return PNG.sync.write(clean)
  } catch {
    throw new InvalidAvatarError('This photo could not be read. Choose another image.')
  }
}

export function avatarDirectory(): string {
  return path.join(getDataDir(), 'profile-photos')
}

export async function removeStoredAvatar(reference: string | null): Promise<void> {
  const parsed = avatarOverrideSchema.safeParse(reference)
  if (!parsed.success) return
  // Only server-issued, validated basenames ever reach the filesystem.
  await fs.unlink(path.join(avatarDirectory(), path.basename(parsed.data))).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') console.error('Failed to remove old profile photo', error)
  })
}

export async function setAvatar(userId: string, input: Buffer | null): Promise<string | null> {
  let reference: string | null = null
  if (input) {
    const png = prepareAvatar(input)
    const filename = `${randomUUID()}.png`
    await fs.mkdir(avatarDirectory(), { recursive: true })
    await fs.writeFile(path.join(avatarDirectory(), filename), png, { flag: 'wx', mode: 0o600 })
    reference = avatarOverrideSchema.parse(`/api/profile/images/${filename}`)
  }
  let previous: string | null
  try {
    previous = await swapAvatarReference(userId, reference)
  } catch (error) {
    await removeStoredAvatar(reference)
    throw error
  }
  await removeStoredAvatar(previous)
  return reference
}

const MAX_SWAP_ATTEMPTS = 5

/**
 * Compare-and-set the override and return what it replaced. Two windows
 * uploading at the same time each swap against the value they read, so each
 * unlinks exactly the file it displaced and neither orphans the other's.
 * Zero changes means the value moved under us (read again) or the user is
 * gone (throw; the caller unlinks the file it just wrote).
 */
async function swapAvatarReference(userId: string, reference: string | null): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
    const found = await db.select({ avatar: user.avatarOverride }).from(user).where(eq(user.id, userId)).get()
    if (!found) throw new Error('User no longer exists')
    const unchanged = found.avatar === null ? isNull(user.avatarOverride) : eq(user.avatarOverride, found.avatar)
    const result = await db.update(user)
      .set({ avatarOverride: reference, updatedAt: new Date() })
      .where(and(eq(user.id, userId), unchanged))
      .run()
    if (changesOf(result) > 0) return found.avatar
  }
  throw new Error('Profile photo changed concurrently; try again')
}
