import type { VolumeType } from '@shared/lib/types/mount'
import { localVolumeSetup } from './local-volume-setup'
import type { VolumeSetupDefinition } from './volume-setup'

/** Add a source's renderer setup here; the dialog and save hooks stay generic. */
export const volumeSetupRegistry: Record<VolumeType, VolumeSetupDefinition> = {
  local: localVolumeSetup,
}
