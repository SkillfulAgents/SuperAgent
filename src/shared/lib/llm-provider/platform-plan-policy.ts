import type { ParsedPlatformAccountInfo, ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'

import type { ModelDefinition } from './model-catalog-schema'
import type { PlatformPlanPolicy } from './platform-plan-cache'
import type { ModelAvailability } from './model-availability-schema'
import { familyDisplayName } from './model-family-names'
import { parseFirstJsonObject } from './error-presentation'

/**
 * Models a workspace's platform plan excludes (SUP-1143). The proxy's
 * `GET /v1/billing` sends `deniedModels` (and `plan.deniedModels`): canonical
 * model-id prefixes. A model is denied when its canonical id starts with one of
 * them, which is the rule the proxy enforces with `403 model_not_in_plan`. An
 * empty list means no restriction. Plans and their lists are data, so nothing
 * here names a plan or a model.
 *
 * Platform-only: the Platform provider and its error presentation read the
 * policy here and hand the app finished availability and wording, so nothing
 * outside them interprets a denylist.
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
 * spans several families or none. Family names are the picker's, so this agrees
 * with the model list.
 */
export function deniedModelName(prefix: string, catalog: readonly ModelDefinition[]): string {
  const matches = catalog.filter((m) => isDeniedByPlan([prefix], m.id))
  const families = new Set(matches.map((m) => m.family))
  const [family] = families
  if (families.size !== 1 || !family) return matches.length === 1 ? matches[0].label : humanizePrefix(prefix)
  const name = familyDisplayName(family)
  const brand = FAMILY_BRAND[matches[0].icon ?? '']
  return brand && !name.startsWith(brand) ? `${brand} ${name}` : name
}

/** "Claude Fable and GPT Astra" for a plan's denylist; null when it excludes nothing. */
export function excludedModelsLabel(deniedModels: readonly string[], catalog: readonly ModelDefinition[]): string | null {
  const names = [...new Set(deniedModels.map((prefix) => deniedModelName(prefix, catalog)))]
  if (names.length === 0) return null
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * The catalog entry a raw model id (as the proxy names it) refers to, or the id
 * itself as both id and label when the catalog has no such model.
 */
export function resolvePlanModel(model: string, catalog: readonly ModelDefinition[]): { id: string; label: string } {
  const canonical = canonicalModelId(model)
  const entry = catalog.find((m) => m.id === model) ?? catalog.find((m) => canonicalModelId(m.id) === canonical)
  return entry ? { id: entry.id, label: entry.label } : { id: model, label: model }
}

/** Display label for a raw model id: its catalog label, else the id itself. */
export function planModelLabel(model: string, catalog: readonly ModelDefinition[]): string {
  return resolvePlanModel(model, catalog).label
}

/**
 * What this workspace is refused right now. The top-level list covers a
 * workspace with no plan too (the free tier's list), so the proxy says to
 * prefer it; `plan.deniedModels` is the fallback for a proxy without it.
 */
export function effectiveDeniedModels(billing: ParsedPlatformBillingInfo | null | undefined): string[] {
  return billing?.deniedModels ?? billing?.plan?.deniedModels ?? []
}

/** The policy a `/v1/account` response carries; null when the proxy did not say. */
export function accountPlanPolicy(account: ParsedPlatformAccountInfo): PlatformPlanPolicy | null {
  return account.deniedModels === null ? null : { planName: account.plan?.name ?? null, deniedModels: account.deniedModels }
}

/** The policy a `/v1/billing` snapshot carries; null from a proxy that predates plans. */
export function billingPlanPolicy(billing: ParsedPlatformBillingInfo): PlatformPlanPolicy | null {
  if (billing.deniedModels == null && !billing.plan) return null
  return { planName: billing.plan?.name ?? null, deniedModels: effectiveDeniedModels(billing) }
}

/** "Claude Fable and GPT Astra": what the workspace's plan excludes, or null when nothing. */
export function platformExcludedModels(
  billing: ParsedPlatformBillingInfo | null | undefined,
  catalog: readonly ModelDefinition[],
): string | null {
  return excludedModelsLabel(effectiveDeniedModels(billing), catalog)
}

/** "Fable 5.1 isn't included in your Pro 30 plan." */
export function notInPlanText(label: string, planName: string | null | undefined): string {
  return `${label} isn't included in ${planName ? `your ${planName} plan` : "your workspace's plan"}.`
}

// Renderer action-registry key for the plan upgrade dialog a locked pick opens.
export const PLATFORM_PLAN_UPGRADE_ACTION = 'platform-plan-upgrade'

/**
 * The connection's availability under the account's plan: the catalog models
 * the denylist covers, each with its reason, a one-line summary, and the
 * upgrade flow. Null when the plan excludes nothing in this catalog, or when
 * the policy is unknown (the proxy refuses nothing it has not published).
 */
export function platformModelAvailability(
  policy: PlatformPlanPolicy | null,
  catalog: readonly ModelDefinition[],
  billingUrl: string | null,
): ModelAvailability | null {
  const denied = policy?.deniedModels ?? []
  const unavailable = catalog.filter((m) => isDeniedByPlan(denied, m.id))
  if (unavailable.length === 0) return null
  const planName = policy?.planName ?? null
  const excluded = excludedModelsLabel(denied, catalog)
  return {
    unavailable: unavailable.map((m) => ({ modelId: m.id, reason: notInPlanText(m.label, planName) })),
    summary: excluded && (planName ? `${planName} excludes ${excluded}.` : `Without a plan, your workspace can't use ${excluded}.`),
    action: { component: PLATFORM_PLAN_UPGRADE_ACTION, label: 'Upgrade', href: billingUrl },
  }
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
