import { s3VolumeSetup } from './s3-volume-setup'
import type { VolumeType } from '@shared/lib/types/mount'
import { localVolumeSetup } from './local-volume-setup'
import { dropboxVolumeSetup } from './dropbox-volume-setup'
import { googleDriveVolumeSetup } from './google-drive-volume-setup'
import type { VolumeSetupDefinition } from './volume-setup'

/** Add a source's renderer setup here; the dialog and save hooks stay generic. */
export const volumeSetupRegistry: Record<VolumeType, VolumeSetupDefinition> = {
  local: localVolumeSetup,
  s3: s3VolumeSetup,
  dropbox: dropboxVolumeSetup,
  googledrive: googleDriveVolumeSetup,
}
