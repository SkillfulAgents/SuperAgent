import type { ComponentType } from 'react'
import type { z } from 'zod'
import type { VolumeType } from '@shared/lib/types/mount'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import type { VolumeDetails } from './volume-details-schema'

export interface VolumeSetupProps {
  initialConfig: unknown
  initialDetails: VolumeDetails
  onSubmit: (config: unknown, details: VolumeDetails) => Promise<void>
  onBack: () => void
  onCancel: () => void
  isSaving: boolean
  error: string | null
  clearError: () => void
  attachToAgent: boolean
}

/** Renderer counterpart of a mountable volume. Each source owns its setup steps;
 * the dialog only chooses a source, validates its config, and saves the result. */
export interface VolumeSetupDefinition<T extends VolumeType = VolumeType> {
  type: T
  label: string
  description: string
  Logo: ComponentType<{ className?: string }>
  configSchema: z.ZodType<Extract<VolumeSource, { type: T }>['config']>
  isAvailable: () => boolean
  unavailableReason?: string
  /** Optional immediate action on source selection. null means cancelled. */
  begin?: () => Promise<Extract<VolumeSource, { type: T }>['config'] | null>
  Setup: ComponentType<VolumeSetupProps>
}
