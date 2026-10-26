import type { ComponentType } from 'react'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import type { TeamBrainLocationId } from '@renderer/lib/team-brain/team-brain-schema'

/**
 * Where Team Brain can keep its files: the first question in set-up. Every drive type there is, straight from the
 * drive setup registry (name, logo, and whether this window can offer it), so a new drive type shows up here on its own.
 */
export interface TeamBrainLocation {
  id: TeamBrainLocationId
  name: string
  description: string
  Icon: ComponentType<{ className?: string }>
  isAvailable: () => boolean
  unavailableReason?: string
}

/** Team Brain's own words for a drive, where they say more than the drive's own description. */
const DESCRIPTIONS: Partial<Record<TeamBrainLocationId, string>> = {
  googledrive: 'A Team Brain folder in My Drive or a shared drive.',
  dropbox: 'A Team Brain folder in your Dropbox.',
}

// In the drives' own order, as their source picker lists them.
export const TEAM_BRAIN_LOCATIONS: readonly TeamBrainLocation[] = Object.values(volumeSetupRegistry).map((drive) => {
  return {
    id: drive.type,
    name: drive.label,
    description: DESCRIPTIONS[drive.type] ?? drive.description,
    Icon: drive.Logo,
    isAvailable: drive.isAvailable,
    unavailableReason: drive.unavailableReason,
  }
})

export function teamBrainLocation(id: TeamBrainLocationId): TeamBrainLocation {
  const location = TEAM_BRAIN_LOCATIONS.find((l) => l.id === id)
  if (!location) throw new Error(`Unknown Team Brain location: ${id}`)
  return location
}
