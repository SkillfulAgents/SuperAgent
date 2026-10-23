import type { ComponentType } from 'react'
import type { z } from 'zod'
import type { VolumeType } from '@shared/lib/types/mount'
import { volumeConfigSchema, type VolumeSource } from '@shared/lib/volumes/volume-config-schema'
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

/** A setup's submitted config as a validated drive source. Throws on an invalid config. */
export function parseVolumeSource(definition: VolumeSetupDefinition, config: unknown): VolumeSource {
  return volumeConfigSchema.parse({ type: definition.type, config: definition.configSchema.parse(config) })
}
