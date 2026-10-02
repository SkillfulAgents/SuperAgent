import { experimentEnabled, type ExperimentId } from '@shared/lib/experiments'
import { useUserSettings } from './use-user-settings'

/**
 * Whether the signed-in user has turned experiment `id` on in Settings →
 * Experiments. Off while settings load, so an experiment's UI never flashes
 * in for someone who has it off.
 */
export function useExperiment(id: ExperimentId): boolean {
  const { data } = useUserSettings()
  return experimentEnabled(data?.experiments, id)
}
