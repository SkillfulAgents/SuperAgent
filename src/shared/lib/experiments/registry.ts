/**
 * Every experiment the app offers, in the order Settings → Experiments lists
 * them. See `./index.ts` for how to add, gate and retire one.
 */
export interface ExperimentDefinition {
  /** Stable key in user settings. Never reuse an id for a different feature. */
  id: string
  /** Shown as the switch's label. */
  name: string
  /** One or two sentences: what turning it on adds, and where to find it. */
  description: string
}

export const EXPERIMENTS = [] as const satisfies readonly ExperimentDefinition[]
