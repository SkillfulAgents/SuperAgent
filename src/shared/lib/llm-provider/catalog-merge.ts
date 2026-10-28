import {
  modelDefinitionSchema,
  type CatalogOverrideEntry,
  type ModelDefinition,
} from './model-catalog-schema'

export function normalizeCatalog(catalog: ModelDefinition[]): ModelDefinition[] {
  const latestIndexByFamily = new Map<string, number>()
  catalog.forEach((model, index) => {
    if (model.isLatest && model.family) {
      latestIndexByFamily.set(model.family, index)
    }
  })

  return catalog.map((model, index) => {
    if (model.isLatest && model.family) {
      if (latestIndexByFamily.get(model.family) !== index) {
        return { ...model, isLatest: false }
      }
    }
    return model
  })
}

function withoutDisabled(entry: CatalogOverrideEntry): Partial<ModelDefinition> & { id: string } {
  const model = { ...entry }
  delete model.disabled
  return model
}

function mergeModelPatch(
  base: Partial<ModelDefinition> & { id: string },
  patch: Partial<ModelDefinition> & { id: string }
): Partial<ModelDefinition> & { id: string } {
  const next = { ...base, ...patch }
  if (base.pricing && patch.pricing) {
    next.pricing = {
      ...base.pricing,
      ...patch.pricing,
      ...(base.pricing.speedMultipliers && patch.pricing.speedMultipliers
        ? {
            speedMultipliers: {
              ...base.pricing.speedMultipliers,
              ...patch.pricing.speedMultipliers,
            },
          }
        : {}),
    }
  }
  return next
}

/**
 * A provider's user-effective catalog:
 * built-ins → per-id overrides (with nested pricing merged) → disabled
 * entries removed → structural validation → family latest normalization.
 */
export function mergeCatalog(
  builtins: ModelDefinition[],
  overrides: CatalogOverrideEntry[]
): ModelDefinition[] {
  const builtinById = new Map(builtins.map((model) => [model.id, model]))
  const byId = new Map<string, Partial<ModelDefinition> & { id: string }>(
    builtins.map((model) => [model.id, model])
  )
  const order = builtins.map((model) => model.id)

  for (const entry of overrides) {
    const current = byId.get(entry.id)
    const builtin = builtinById.get(entry.id)

    if (entry.disabled === true) {
      if (current || builtin) byId.delete(entry.id)
      continue
    }

    const patch = withoutDisabled(entry)
    const base = current ?? builtin
    const next = base ? mergeModelPatch(base, patch) : patch
    if (!base && !order.includes(entry.id)) order.push(entry.id)
    byId.set(entry.id, next)
  }

  const valid: ModelDefinition[] = []
  for (const id of order) {
    const model = byId.get(id)
    if (!model) continue

    const parsed = modelDefinitionSchema.safeParse(model)
    if (!parsed.success) {
      console.warn(
        `Dropping invalid model catalog entry "${id}":`,
        parsed.error.issues[0]?.message ?? parsed.error.message
      )
      continue
    }
    valid.push(parsed.data)
  }

  return normalizeCatalog(valid)
}
