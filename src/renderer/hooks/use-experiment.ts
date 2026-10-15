import { useContext, useEffect } from 'react'
import { experimentEnabled, type ExperimentId } from '@shared/lib/experiments'
import { AnalyticsContext } from '@renderer/context/analytics-context'
import { useUserSettings } from './use-user-settings'

// Once per app run per experiment, so a gate rendered in five places counts one exposure.
const exposed = new Set<string>()

/**
 * Whether the signed-in user has turned experiment `id` on in Settings →
 * Experiments. Off while settings load, so an experiment's UI never flashes
 * in for someone who has it off.
 */
export function useExperiment(id: ExperimentId): boolean {
  const { data } = useUserSettings()
  const analytics = useContext(AnalyticsContext)
  const enabled = experimentEnabled(data?.experiments, id)
  useEffect(() => {
    if (!enabled || !analytics || exposed.has(id)) return
    exposed.add(id)
    analytics.track('experiment_exposure', { experiment_key: id, variant: 'on' })
  }, [analytics, enabled, id])
  return enabled
}
