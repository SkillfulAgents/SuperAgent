import { EXPERIMENTS, type ExperimentDefinition } from './registry'

/**
 * Experimental features: work that ships in the build but stays off until a
 * person turns it on for themselves in Settings → Experiments. Each one is a
 * per-user switch stored in user settings (`experiments`), so turning one on
 * changes nothing for anyone else on the same deployment.
 *
 * To add one, append an entry to `EXPERIMENTS` in `./registry.ts` and gate
 * the feature on `useExperiment(id)` in the renderer (or
 * `isExperimentEnabled(userId, id)` on the server). To retire one, delete its
 * entry along with the gates: a stored switch for an id that is no longer
 * listed is ignored on read.
 */
export { EXPERIMENTS, type ExperimentDefinition }

export type ExperimentId = (typeof EXPERIMENTS)[number]['id']

/** Experiment id → on/off, as stored in user settings. Absent = off. */
export type ExperimentSwitches = Record<string, boolean>

export function listExperiments(): readonly ExperimentDefinition[] {
  return EXPERIMENTS
}

export function isKnownExperiment(id: string): id is ExperimentId {
  return listExperiments().some((experiment) => experiment.id === id)
}

/** Whether a set of stored switches turns `id` on. Unlisted ids are always off. */
export function experimentEnabled(switches: ExperimentSwitches | undefined, id: string): boolean {
  return isKnownExperiment(id) && switches?.[id] === true
}
