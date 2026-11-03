import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { decode, encode } from 'fast-png'
import { Unzlib } from 'fflate'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { user } from '@shared/lib/db/schema'
import { getDataDir } from '@shared/lib/config/data-dir'
import { hostFiles } from '@shared/lib/blob-store/blob-store'
import { avatarOverrideSchema, MAX_AVATAR_BYTES } from '@shared/lib/user-profile-schema'

export class InvalidAvatarError extends Error {}
const MAX_DIMENSION = 512
/** Samples per pixel of each PNG color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** Deflate data this small inflates to at most about a megabyte. */
const INFLATE_PIECE_BYTES = 1024

/**
 * The size zlib `data` inflates to, counted until it passes `limit`: inflating
 * stops there, so a few bytes that inflate to a gigabyte cost no more than a
 * real image. (An `out` buffer does not stop fflate: it inflates all of it.)
 */
export function inflatedSizeUpTo(data: Uint8Array, limit: number): number {
  let size = 0
  const inflater = new Unzlib((chunk) => {
    size += chunk.length
  })
  for (let offset = 0; offset < data.length && size <= limit; offset += INFLATE_PIECE_BYTES) {
    inflater.push(data.subarray(offset, offset + INFLATE_PIECE_BYTES), offset + INFLATE_PIECE_BYTES >= data.length)
  }
  return size
}

/** Decode and re-encode a bounded raster: don't persist untrusted ancillary data. */
export function prepareAvatar(input: Buffer): Buffer {
  if (input.length < 33 || input.length > MAX_AVATAR_BYTES
    || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || input.toString('ascii', 12, 16) !== 'IHDR') {
    throw new InvalidAvatarError('Choose a PNG image under 1 MB.')
  }
  // Canvas uploads are non-interlaced; reject interlacing and a second IHDR
  // before the decoder can allocate.
  if (input.readUInt32BE(8) !== 13 || input[28] !== 0) {
    throw new InvalidAvatarError('Choose a standard, non-interlaced PNG image.')
  }
  const imageData: Buffer[] = []
  for (let offset = 8; offset < input.length;) {
    if (offset + 12 > input.length) throw new InvalidAvatarError('Incomplete PNG image.')
    const length = input.readUInt32BE(offset)
    const type = input.toString('ascii', offset + 4, offset + 8)
    if (length > input.length - offset - 12 || (offset !== 8 && type === 'IHDR')) {
      throw new InvalidAvatarError('Invalid PNG image.')
    }
    if (type === 'IDAT') imageData.push(input.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const width = input.readUInt32BE(16)
  const height = input.readUInt32BE(20)
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new InvalidAvatarError('Photo dimensions must be at most 512 × 512 pixels.')
  }
  const channels = CHANNELS[input[25]]
  const depth = input[24]
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new InvalidAvatarError('Invalid PNG image.')
  // The image data inflates to exactly this size: one filter byte per row. Counting stops just past
  // it, which bounds the work before the decoder inflates it again; any other size is not this image.
  const inflatedSize = height * (1 + Math.ceil((width * channels * depth) / 8))
  try {
    if (inflatedSizeUpTo(Buffer.concat(imageData), inflatedSize) !== inflatedSize) {
      throw new Error('Image data does not match the image size')
    }
    const { data, depth: bitDepth, channels: samples, palette, transparency } = decode(input, { checkCrc: true })
    return Buffer.from(encode({ width, height, data, depth: bitDepth, channels: samples, palette, transparency }))
  } catch {
    throw new InvalidAvatarError('This photo could not be read. Choose another image.')
  }
}

export function avatarDirectory(): string {
  return path.join(getDataDir(), 'profile-photos')
}

const avatarFiles = hostFiles('profile-photos', avatarDirectory)

/** A stored photo's PNG bytes, or null when there is none under that name. */
export function readStoredAvatar(filename: string): Promise<Uint8Array | null> {
  return avatarFiles.read(filename)
}

export async function removeStoredAvatar(reference: string | null): Promise<void> {
  const parsed = avatarOverrideSchema.safeParse(reference)
  if (!parsed.success) return
  // Only server-issued, validated basenames ever reach storage.
  await avatarFiles.remove(path.basename(parsed.data)).catch((error) => {
    console.error('Failed to remove old profile photo', error)
  })
}

export async function setAvatar(userId: string, input: Buffer | null): Promise<string | null> {
  let reference: string | null = null
  if (input) {
    const png = prepareAvatar(input)
    const filename = `${randomUUID()}.png`
    await avatarFiles.write(filename, png)
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
