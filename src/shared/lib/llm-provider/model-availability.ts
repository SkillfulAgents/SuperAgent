import type { ModelDefinition } from './model-catalog-schema'

/** Prefer an available model from the same vendor, then catalog defaults. */
export function bestAllowedModel(
  catalog: readonly ModelDefinition[],
  isUnavailable: (model: ModelDefinition) => boolean,
  near?: Pick<ModelDefinition, 'icon'>,
): ModelDefinition | undefined {
  const available = catalog.filter(model => !isUnavailable(model))
  const sameVendor = near?.icon ? available.filter(model => model.icon === near.icon) : []
  return (
    sameVendor.find(model => model.isDefault) ??
    sameVendor.find(model => model.isLatest) ??
    available.find(model => model.isDefault) ??
    available.find(model => model.isLatest) ??
    available[0]
  )
}
