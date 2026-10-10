import { z } from 'zod'
import { VOLUME_TYPES, type StoredVolume, type VolumeType } from '@shared/lib/types/mount'
import { LocalMountableVolume, localVolumeConfigSchema, prepareLocalVolume } from './local-mountable-volume'
import type { BaseMountableVolume } from './base-mountable-volume'
import type { VolumeFolderBrowser, VolumeSetupViewer } from './volume-folder-browser'
import { VolumeError } from './volume-error'

/** A new volume's type, its checked config, and the name it is given before any clash suffix. */
interface PreparedVolume {
  type: VolumeType
  name: string
  config: unknown
}

interface VolumeTypeEntry {
  instantiate(row: StoredVolume, agentSlug?: string): BaseMountableVolume<unknown> | null
  prepare(config: unknown, creator?: { userId: string | null }): Promise<{ name: string; config: unknown }>
  browseFolders?: VolumeFolderBrowser
}

// Each type's functions are bound to its schema, so they receive the config that schema produced.
function volumeType<C>(
  schema: z.ZodType<C>,
  create: (row: StoredVolume, config: C, agentSlug?: string) => BaseMountableVolume<C>,
  prepare: (config: C, creator?: { userId: string | null }) => Promise<{ name: string; config: C }>,
  browseFolders?: VolumeFolderBrowser,
): VolumeTypeEntry {
  return {
    browseFolders,
    instantiate(row, agentSlug) {
      const config = schema.safeParse(row.config)
      if (config.success) return create(row, config.data, agentSlug)
      console.warn(`[volumes] Volume ${row.id} of type ${row.type} has an invalid config; leaving it out:`, config.error.message)
      return null
    },
    async prepare(input, creator) {
      const config = schema.safeParse(input)
      if (!config.success) throw new Error(`Invalid volume config: ${z.prettifyError(config.error)}`)
      return prepare(config.data, creator)
    },
  }
}

const volumeTypes: Record<VolumeType, VolumeTypeEntry> = {
  local: volumeType(localVolumeConfigSchema, (row, config) => new LocalMountableVolume(row.id, row.name, config), prepareLocalVolume),
}

function isVolumeType(type: string): type is VolumeType {
  return VOLUME_TYPES.some((known) => known === type)
}

/** The volume a stored row describes, or null when its config is not that type's. */
export function instantiateVolume(row: StoredVolume, agentSlug?: string): BaseMountableVolume<unknown> | null {
  return volumeTypes[row.type].instantiate(row, agentSlug)
}

/** A new volume of a type, checked by that type, or a rejection whose message is for the user. */
export async function prepareVolume(type: string, config: unknown, creator?: { userId: string | null }): Promise<PreparedVolume> {
  if (!isVolumeType(type)) throw new Error(`Unknown volume type: ${type}`)
  return { type, ...(await volumeTypes[type].prepare(config, creator)) }
}

/** Setup browsing happens before there is a saved definition. Local deliberately has no
 * server-side browser: selecting a local folder uses the native OS picker. */
export async function browseVolumeFolders(type: string, query: unknown, viewer: VolumeSetupViewer) {
  if (!isVolumeType(type)) throw new VolumeError(`Unknown volume type: ${type}`, 404)
  const browse = volumeTypes[type].browseFolders
  if (!browse) throw new VolumeError('This volume source does not support folder browsing', 400)
  return browse(query, viewer)
}
