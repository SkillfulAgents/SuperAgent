import { z } from 'zod'
import { GithubMountableVolume, prepareGithubVolume } from './github-mountable-volume'
import { githubVolumeConfigSchema } from './github-schema'
import { removeGithubSync } from './github-sync'
import { S3MountableVolume } from './s3-mountable-volume'
import { s3VolumeConfigSchema, s3StoredConfigSchema } from './s3-schema'
import { prepareS3Volume, validateS3Volume } from './s3-validation'
import type { VolumeValidation } from './volume-validation-schema'
import { VOLUME_TYPES, type StoredVolume, type VolumeType } from '@shared/lib/types/mount'
import { LocalMountableVolume, localVolumeConfigSchema, prepareLocalVolume } from './local-mountable-volume'
import { DropboxMountableVolume, prepareDropboxVolume } from './dropbox-mountable-volume'
import { dropboxVolumeConfigSchema } from './dropbox-schema'
import { GoogleDriveMountableVolume, prepareGoogleDriveVolume } from './google-drive-mountable-volume'
import { googleDriveVolumeConfigSchema } from './google-drive-schema'
import { PlatformMountableVolume, preparePlatformVolume } from './platform-mountable-volume'
import { storedPlatformVolumeConfigSchema } from './volume-config-schema'
import type { BaseMountableVolume } from './base-mountable-volume'
import type { VolumeFolderBrowser, VolumeFolderCreator, VolumeSetupViewer } from './volume-folder-browser'
import { VolumeError } from './volume-error'

/** A new volume's type, its checked config, and the name it is given before any clash suffix. */
interface PreparedVolume {
  type: VolumeType
  name: string
  config: unknown
}

interface VolumeTypeEntry {
  remove?: (id: string) => Promise<void>
  instantiate(row: StoredVolume, agentSlug?: string): BaseMountableVolume<unknown> | null
  prepare(config: unknown, creator?: { userId: string | null }): Promise<{ name: string; config: unknown }>
  browseFolders?: VolumeFolderBrowser
  createFolder?: VolumeFolderCreator
  validate?: (config: unknown, viewer: VolumeSetupViewer) => Promise<VolumeValidation>
}

// Each type's functions are bound to its schemas, so they receive the config those schemas produced:
// `prepare` the setup input, `create` the stored config (the same schema unless the type stores another).
function volumeType<C, S = C>(
  schema: z.ZodType<C>,
  create: (row: StoredVolume, config: S, agentSlug?: string) => BaseMountableVolume<unknown>,
  prepare: (config: C, creator?: { userId: string | null }) => Promise<{ name: string; config: S }>,
  options: { stored?: z.ZodType<S>; browseFolders?: VolumeFolderBrowser; createFolder?: VolumeFolderCreator; validate?: VolumeTypeEntry['validate'] } = {},
): VolumeTypeEntry {
  // With no stored schema, S defaults to C.
  const stored = options.stored ?? schema as unknown as z.ZodType<S>
  return {
    browseFolders: options.browseFolders,
    createFolder: options.createFolder,
    validate: options.validate,
    instantiate(row, agentSlug) {
      const config = stored.safeParse(row.config)
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
  github: {
    ...volumeType(githubVolumeConfigSchema, (row, config, agentSlug) => new GithubMountableVolume(row.id, row.name, config,
      'volumeId' in row && typeof row.volumeId === 'string' ? row.volumeId : row.id, agentSlug), prepareGithubVolume,
      { browseFolders: GithubMountableVolume.browseFolders }),
    remove: removeGithubSync,
  },
  s3: volumeType(s3VolumeConfigSchema, (row, config, agentSlug) => new S3MountableVolume(row.id, row.name, config, agentSlug), prepareS3Volume,
    { stored: s3StoredConfigSchema, validate: validateS3Volume }),
  dropbox: volumeType(dropboxVolumeConfigSchema, (row, config, agentSlug) => new DropboxMountableVolume(row.id, row.name, config, agentSlug), prepareDropboxVolume,
    { browseFolders: DropboxMountableVolume.browseFolders }),
  googledrive: volumeType(googleDriveVolumeConfigSchema, (row, config, agentSlug) => new GoogleDriveMountableVolume(row.id, row.name, config, agentSlug), prepareGoogleDriveVolume,
    { browseFolders: GoogleDriveMountableVolume.browseFolders, createFolder: GoogleDriveMountableVolume.createFolder }),
  local: volumeType(localVolumeConfigSchema, (row, config) => new LocalMountableVolume(row.id, row.name, config), prepareLocalVolume),
  platform: volumeType(storedPlatformVolumeConfigSchema, (row, config, agentSlug) => new PlatformMountableVolume(row.id, row.name, config, agentSlug), preparePlatformVolume,
    { browseFolders: PlatformMountableVolume.browseFolders, createFolder: PlatformMountableVolume.createFolder }),
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

/** A setup step a type may offer, or the error its route answers: 404 for an unknown type, 400 for one without it. */
function setupStep<K extends 'browseFolders' | 'createFolder' | 'validate'>(type: string, step: K, missing: string): NonNullable<VolumeTypeEntry[K]> {
  if (!isVolumeType(type)) throw new VolumeError(`Unknown volume type: ${type}`, 404)
  const run = volumeTypes[type][step]
  if (!run) throw new VolumeError(missing, 400)
  return run
}

/** Setup browsing happens before there is a saved definition. Local deliberately has no
 * server-side browser: selecting a local folder uses the native OS picker. */
export async function browseVolumeFolders(type: string, query: unknown, viewer: VolumeSetupViewer) {
  return setupStep(type, 'browseFolders', 'This volume source does not support folder browsing')(query, viewer)
}

/** A source that can make a folder from the setup picker says so here; the rest offer no New folder. */
export async function createVolumeFolder(type: string, input: unknown, viewer: VolumeSetupViewer) {
  return setupStep(type, 'createFolder', 'This volume source does not support creating folders')(input, viewer)
}

/** Validation before saving remains source-owned, just like setup folder browsing. */
export async function validateVolumeSource(type: string, config: unknown, viewer: VolumeSetupViewer): Promise<VolumeValidation> {
  return setupStep(type, 'validate', 'This source does not support a connection check')(config, viewer)
}

export async function removeVolume(type: string, id: string): Promise<void> {
  if (isVolumeType(type)) await volumeTypes[type].remove?.(id)
}
