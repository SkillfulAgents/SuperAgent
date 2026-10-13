import type { ModelDefinition } from './model-catalog-schema'
import { parseFirstJsonObject } from './error-presentation'

/**
 * Models a workspace's platform plan excludes (SUP-1143). The proxy's
 * `GET /v1/billing` sends `plan.deniedModels`: canonical model-id prefixes. A
 * model is denied when its canonical id starts with one of them, which is the
 * rule the proxy enforces with `403 model_not_in_plan`. An empty list or no
 * plan means no restriction. Plans and their lists are data, so nothing here
 * names a plan or a model.
 */

/**
 * The proxy's `canonicalizeModel`, lower-cased: no vendor prefix
 * (`bedrock.anthropic.`, `anthropic/`), no date stamp. Mirrored so a prefix
 * matches the same ids here as it does at the proxy.
 */
export function canonicalModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z-]+\.)?anthropic[./]/, '')
    .replace(/^@cf\/[^/]+\//, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, '')
}

/** The proxy's parse of a denylist: strings only, trimmed, lower-cased, no empties. */
export function normalizeDeniedModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

/** The denylist entry that excludes `model`, or null when the plan allows it. */
export function planDeniedPrefix(deniedModels: readonly string[], model: string): string | null {
  if (deniedModels.length === 0) return null
  const canonical = canonicalModelId(model)
  return deniedModels.find((prefix) => canonical.startsWith(prefix)) ?? null
}

export function isDeniedByPlan(deniedModels: readonly string[], model: string): boolean {
  return planDeniedPrefix(deniedModels, model) !== null
}

/**
 * The model to use instead of a denied one: the denied model's own vendor
 * default when allowed (Fable → Opus), then the catalog's defaults, then its
 * newest entries, then anything allowed. Undefined when the plan allows nothing
 * in this catalog. `isDenied` is the plan's verdict on a catalog entry.
 */
export function bestAllowedModel(
  catalog: readonly ModelDefinition[],
  isDenied: (model: ModelDefinition) => boolean,
  near?: Pick<ModelDefinition, 'icon'>,
): ModelDefinition | undefined {
  const allowed = catalog.filter((m) => !isDenied(m))
  const sameVendor = near?.icon ? allowed.filter((m) => m.icon === near.icon) : []
  return (
    sameVendor.find((m) => m.isDefault) ??
    sameVendor.find((m) => m.isLatest) ??
    allowed.find((m) => m.isDefault) ??
    allowed.find((m) => m.isLatest) ??
    allowed[0]
  )
}

// Brand words a family name leaves out ("Fable" is Claude's; "GPT Astra" already says it).
const FAMILY_BRAND: Record<string, string> = { anthropic: 'Claude' }

function humanizePrefix(prefix: string): string {
  return prefix
    .replace(/[-.]+$/, '')
    .split('-')
    .filter(Boolean)
    .map((word) => (word === 'gpt' || word === 'glm' ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * Display name for one denylist entry: "Claude Fable" for `claude-fable-`, the
 * one family it covers in the catalog, or a readable form of the prefix when it
 * spans several families or none. `familyName` turns a family key into its
 * picker name, so this agrees with the model list.
 */
export function deniedModelName(
  prefix: string,
  catalog: readonly ModelDefinition[],
  familyName: (family: string) => string,
): string {
  const matches = catalog.filter((m) => isDeniedByPlan([prefix], m.id))
  const families = new Set(matches.map((m) => m.family))
  const [family] = families
  if (families.size !== 1 || !family) return matches.length === 1 ? matches[0].label : humanizePrefix(prefix)
  const name = familyName(family)
  const brand = FAMILY_BRAND[matches[0].icon ?? '']
  return brand && !name.startsWith(brand) ? `${brand} ${name}` : name
}

/** "Claude Fable and GPT Astra" for a plan's denylist; null when it excludes nothing. */
export function excludedModelsLabel(
  deniedModels: readonly string[],
  catalog: readonly ModelDefinition[],
  familyName: (family: string) => string,
): string | null {
  const names = [...new Set(deniedModels.map((prefix) => deniedModelName(prefix, catalog, familyName)))]
  if (names.length === 0) return null
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Display label for a raw model id: its catalog label, else the id itself. */
export function planModelLabel(model: string, catalog: readonly ModelDefinition[]): string {
  const canonical = canonicalModelId(model)
  return catalog.find((m) => m.id === model || canonicalModelId(m.id) === canonical)?.label ?? model
}

export const MODEL_NOT_IN_PLAN_ERROR = 'model_not_in_plan'

function readModelNotInPlan(record: Record<string, unknown>): { model: string | null } | null {
  const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : record
  if (nested.type !== MODEL_NOT_IN_PLAN_ERROR) return null
  return { model: typeof nested.model === 'string' && nested.model.trim() ? nested.model.trim() : null }
}

/**
 * The proxy's `403 model_not_in_plan` refusal, from a structured body or the
 * CLI's error text. `model` is the refused model when the body named it. Null
 * for every other error. Persisted history rows carry no status, so this keys
 * on the error type alone.
 */
export function parseModelNotInPlan(body: unknown): { model: string | null } | null {
  if (body && typeof body === 'object') return readModelNotInPlan(body as Record<string, unknown>)
  if (typeof body !== 'string' || !body.includes(MODEL_NOT_IN_PLAN_ERROR)) return null
  const parsed = parseFirstJsonObject(body)
  const fromJson = parsed && typeof parsed === 'object' ? readModelNotInPlan(parsed as Record<string, unknown>) : null
  return fromJson ?? { model: null }
}
