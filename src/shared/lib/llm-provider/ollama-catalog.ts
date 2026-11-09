import type { EffortLevel } from '../container/types'
import type { CatalogOverrideEntry, ModelDefinition } from './model-catalog-schema'
import type { InstalledModel } from './server-status-schema'

const EFFORTS_WITH_THINKING: EffortLevel[] = ['low', 'medium', 'high']
// The schema needs one; a model that cannot think has no effort to choose.
const EFFORTS_WITHOUT_THINKING: EffortLevel[] = ['medium']

/** The catalog entry for an installed model. Local inference has no price, so none is declared. */
export function ollamaModelDefinition(model: InstalledModel): ModelDefinition {
  return {
    id: model.id,
    label: model.label,
    icon: 'ollama',
    supportedEfforts: model.supportsThinking ? EFFORTS_WITH_THINKING : EFFORTS_WITHOUT_THINKING,
    // Anthropic's web tools are served by Anthropic; Ollama does not run them.
    supportsWebSearch: false,
    supportsImageInput: model.supportsImageInput,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  }
}

/**
 * A connection's overrides after looking at what its server has installed:
 * every runnable model is listed, and an entry the person switched off stays
 * off. With `remove`, an entry for a model no longer installed goes too, except
 * a switched-off one (so it comes back off) and those in `keep`. Returns the
 * same array when nothing changed.
 */
export function mergeInstalledModels(
  overrides: CatalogOverrideEntry[],
  installed: readonly InstalledModel[],
  options: { remove: boolean; keep?: ReadonlySet<string> },
): CatalogOverrideEntry[] {
  const runnable = installed.filter(model => !model.unusableReason)
  const runnableIds = new Set(runnable.map(model => model.id))
  const existing = new Map(overrides.map(entry => [entry.id, entry]))
  const kept = overrides.filter(entry =>
    !options.remove || runnableIds.has(entry.id) || entry.disabled || options.keep?.has(entry.id))
  const next: CatalogOverrideEntry[] = kept.map((entry) => {
    const model = runnable.find(candidate => candidate.id === entry.id)
    if (!model) return entry
    return { ...ollamaModelDefinition(model), ...(entry.disabled ? { disabled: true } : {}) }
  })
  for (const model of runnable) {
    if (!existing.has(model.id)) next.push(ollamaModelDefinition(model))
  }
  return JSON.stringify(next) === JSON.stringify(overrides) ? overrides : next
}
