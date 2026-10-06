import { z } from 'zod'
import { VOLUME_TYPES, type StoredVolume, type VolumeType } from '@shared/lib/types/mount'
import { LocalMountableVolume, localVolumeConfigSchema, prepareLocalVolume } from './local-mountable-volume'
import type { BaseMountableVolume } from './base-mountable-volume'

/** A new volume's type, its checked config, and the name it is given before any clash suffix. */
interface PreparedVolume {
  type: VolumeType
  name: string
  config: unknown
}

interface VolumeTypeEntry {
  instantiate(row: StoredVolume): BaseMountableVolume<unknown> | null
  prepare(config: unknown): Promise<{ name: string; config: unknown }>
}

// Each type's functions are bound to its schema, so they receive the config that schema produced.
function volumeType<C>(
  schema: z.ZodType<C>,
  create: (row: StoredVolume, config: C) => BaseMountableVolume<C>,
  prepare: (config: C) => Promise<{ name: string; config: C }>,
): VolumeTypeEntry {
  return {
    instantiate(row) {
      const config = schema.safeParse(row.config)
      if (config.success) return create(row, config.data)
      console.warn(`[volumes] Volume ${row.id} of type ${row.type} has an invalid config; leaving it out:`, config.error.message)
      return null
    },
    async prepare(input) {
      const config = schema.safeParse(input)
      if (!config.success) throw new Error(`Invalid volume config: ${z.prettifyError(config.error)}`)
      return prepare(config.data)
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
export function instantiateVolume(row: StoredVolume): BaseMountableVolume<unknown> | null {
  return volumeTypes[row.type].instantiate(row)
}

/** A new volume of a type, checked by that type, or a rejection whose message is for the user. */
export async function prepareVolume(type: string, config: unknown): Promise<PreparedVolume> {
  if (!isVolumeType(type)) throw new Error(`Unknown volume type: ${type}`)
  return { type, ...(await volumeTypes[type].prepare(config)) }
}
