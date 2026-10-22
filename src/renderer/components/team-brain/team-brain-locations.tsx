import type { ComponentType } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { VolumeType } from '@shared/lib/types/mount'
import { canUseHostFeatures } from '@renderer/lib/capabilities'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import type { TeamBrainLocationId } from '@renderer/lib/team-brain/team-brain-schema'

/**
 * Where Team Brain can keep its files: the first question in set-up. The
 * drive-backed options come straight from the drive setup registry (name,
 * logo, and whether this window can offer it), so a new drive type shows up
 * here with nothing more than its copy below. Gamut hosting, GitHub and
 * Obsidian are the three homes the drives don't cover yet.
 */
export interface TeamBrainLocation {
  id: TeamBrainLocationId
  name: string
  description: string
  group: 'hosted' | 'storage'
  Icon: ComponentType<{ className?: string }>
  isAvailable: () => boolean
  unavailableReason?: string
}

/** The Gamut mark, from the website's gamut-mark.svg. */
export function GamutMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 5600 5600" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M728.111 2933.85C942.138 3304.25 1226.2 3676 1572.62 4022.42C1944.74 4394.54 2346.07 4694.7 2743.58 4913.4C2488.55 5178.45 2132.18 5343.05 1737.83 5343.06C962.42 5343.06 333.828 4706.63 333.828 3921.56C333.828 3537.82 484.009 3189.59 728.111 2933.85ZM579.263 573.263C1257.41 -104.886 2801.65 339.858 4028.42 1566.63C5255.19 2793.39 5699.93 4337.63 5021.78 5015.78C4549.34 5488.23 3656.54 5415.68 2743.58 4913.4C2990.02 4657.27 3141.83 4307.37 3141.83 3921.56C3141.83 3136.48 2513.24 2500.06 1737.83 2500.06C1341.43 2500.06 983.407 2666.38 728.111 2933.85C184.221 1992.57 92.6148 1059.91 579.263 573.263Z"
      />
    </svg>
  )
}

/** A plain gem standing in for the Obsidian logo until we bundle the real one. */
function ObsidianMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M8.6 2.4 16.2 4l3.4 7.2-4.6 10.4-7-1.6-3.6-7.2z" fill="#7c3aed" />
      <path d="M8.6 2.4 11 12l-3 8-3.6-7.2z" fill="#a78bfa" />
      <path d="M11 12l8.6-.8L15 21.6z" fill="#5b21b6" />
    </svg>
  )
}

function GitHubMark({ className }: { className?: string }) {
  return <ServiceIcon slug="github" className={cn(className, 'dark:invert')} />
}

function fromDrive(
  type: VolumeType,
  copy: { description?: string } = {},
): TeamBrainLocation {
  const drive = volumeSetupRegistry[type]
  return {
    id: type,
    name: drive.label,
    description: copy.description ?? drive.description,
    group: 'storage',
    Icon: drive.Logo,
    isAvailable: drive.isAvailable,
    unavailableReason: drive.unavailableReason,
    ...copy,
  }
}

export const TEAM_BRAIN_LOCATIONS: readonly TeamBrainLocation[] = [
  {
    id: 'gamut',
    name: 'Gamut',
    description: 'We host it for you. Nothing to connect.',
    group: 'hosted',
    Icon: GamutMark,
    isAvailable: () => true,
  },
  fromDrive('googledrive', {
    description: 'A Team Brain folder in My Drive or a shared drive.',
  }),
  fromDrive('dropbox', {
    description: 'A Team Brain folder in your Dropbox.',
  }),
  {
    id: 'github',
    name: 'GitHub',
    description: 'A private repository. Every change is a commit you can review.',
    group: 'storage',
    Icon: GitHubMark,
    isAvailable: () => true,
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'A vault on this computer that you can open in Obsidian.',
    group: 'storage',
    Icon: ObsidianMark,
    isAvailable: canUseHostFeatures,
    unavailableReason: 'Available in the desktop app for a local workspace.',
  },
  fromDrive('s3'),
  fromDrive('local'),
]

export function teamBrainLocation(id: TeamBrainLocationId): TeamBrainLocation {
  const location = TEAM_BRAIN_LOCATIONS.find((l) => l.id === id)
  if (!location) throw new Error(`Unknown Team Brain location: ${id}`)
  return location
}
