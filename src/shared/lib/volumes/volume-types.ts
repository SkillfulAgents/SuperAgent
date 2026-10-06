import { z } from 'zod'
import type { StoredVolume } from '@shared/lib/types/mount'
import { LocalMountableVolume, localVolumeConfigSchema, prepareLocalVolume } from './local-mountable-volume'
import type { BaseMountableVolume } from './volumes'

/** A new volume's checked config, and the name it is given before any clash suffix. */
interface PreparedVolume {
  name: string
  config: unknown
}

interface VolumeType {
  instantiate(row: StoredVolume): BaseMountableVolume<unknown> | null
  prepare(config: unknown): Promise<PreparedVolume>
}

// Each type's functions are bound to its schema, so they receive the config that schema produced.
function volumeType<C>(
  schema: z.ZodType<C>,
  create: (row: StoredVolume, config: C) => BaseMountableVolume<C>,
  prepare: (config: C) => Promise<{ name: string; config: C }>,
): VolumeType {
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

const volumeTypes: Record<string, VolumeType> = {
  local: volumeType(localVolumeConfigSchema, (row, config) => new LocalMountableVolume(row.id, row.name, config), prepareLocalVolume),
}

// An own-property check, so a type such as 'toString' is not read off the prototype.
function typeNamed(type: string): VolumeType | undefined {
  return Object.hasOwn(volumeTypes, type) ? volumeTypes[type] : undefined
}

/** The volume a stored row describes, or null when its type is unknown here or its config is not that type's. */
export function instantiateVolume(row: StoredVolume): BaseMountableVolume<unknown> | null {
  const entry = typeNamed(row.type)
  if (!entry) {
    console.warn(`[volumes] Volume ${row.id} has unknown type ${row.type}; leaving it out`)
    return null
  }
  return entry.instantiate(row)
}

/** A new volume of a type, checked by that type, or a rejection whose message is for the user. */
export async function prepareVolume(type: string, config: unknown): Promise<PreparedVolume> {
  const entry = typeNamed(type)
  if (!entry) throw new Error(`Unknown volume type: ${type}`)
  return entry.prepare(config)
}
