import { modelPricingCandidates } from './model-pricing-ids'
import type { ModelDefinition } from './model-catalog-schema'

// Newest generation first; variants follow vendor positioning, not token prices.
const MODEL_RELEASES: readonly [string, readonly string[]][] = [
  ['Claude 5.5', ['claude-opus-5-5', 'claude-sonnet-5-5']],
  ['Claude 5.1', ['claude-fable-5-1']],
  ['Claude 5', ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5']],
  ['Claude 4.8', ['claude-opus-4-8']],
  ['Claude 4.7', ['claude-opus-4-7']],
  ['Claude 4.6', ['claude-opus-4-6', 'claude-sonnet-4-6']],
  ['Claude 4.5', ['claude-haiku-4-5']],
  ['GPT-6.1', ['gpt-6.1-sol']],
  ['GPT-6', ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']],
  ['GPT-5.6', ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']],
  ['GPT-5.5', ['gpt-5.5']],
  ['GPT-5.4', ['gpt-5.4']],
  ['Grok 4.7', ['grok-4.7']],
  ['Grok 4.6', ['grok-4.6']],
  ['Grok 4.5', ['grok-4.5']],
  ['Kimi K3', ['kimi-k3']],
  ['Kimi K2.7 Code', ['kimi-k2.7-code']],
  ['Kimi K2.6', ['kimi-k2.6']],
  ['Muse Spark 1.3', ['muse-spark-1.3', 'muse-spark-1.3-contributor']],
  ['Muse Spark 1.2', ['muse-spark-1.2', 'muse-spark-1.2-contributor']],
  ['Muse Spark 1.1', ['muse-spark-1.1']],
  ['GLM-5.3', ['glm-5.3', 'glm-5.3-flash']],
  ['GLM-5.2', ['glm-5.2']],
  ['DeepSeek V4.1', ['deepseek-v4.1-flash']],
  ['MiniMax M3', ['MiniMax-M3']],
]

const DISPLAY_ORDER = new Map(
  MODEL_RELEASES.flatMap(([releaseGroup, models], releaseOrder) =>
    models.map((id, variantOrder) => [id, { releaseGroup, releaseOrder, variantOrder }] as const),
  ),
)

export function modelDisplayOrder(id: string) {
  const canonical = modelPricingCandidates(id, { vendorPrefixesOnly: true })
    .find((candidate) => DISPLAY_ORDER.has(candidate))
  return canonical === undefined ? undefined : DISPLAY_ORDER.get(canonical)
}

export function compareModelDisplayOrder(a: ModelDefinition, b: ModelDefinition): number {
  const ao = modelDisplayOrder(a.id)
  const bo = modelDisplayOrder(b.id)
  if (!ao || !bo) return Number(!!bo) - Number(!!ao)
  return ao.releaseOrder - bo.releaseOrder || ao.variantOrder - bo.variantOrder
}
