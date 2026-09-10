import { notifyUserProfileChanged } from './agent-members-service'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
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
    // The read + swap is atomic even when two windows upload at the same time.
    previous = db.transaction((tx) => {
      const found = tx.select({ avatar: user.avatarOverride }).from(user).where(eq(user.id, userId)).get()
      if (!found) throw new Error('User no longer exists')
      tx.update(user).set({ avatarOverride: reference, updatedAt: new Date() }).where(eq(user.id, userId)).run()
      return found.avatar
    })
  } catch (error) {
    await removeStoredAvatar(reference)
    throw error
  }
  await removeStoredAvatar(previous)
  notifyUserProfileChanged(userId)
  return reference
}
