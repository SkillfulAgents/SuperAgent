import MODEL_PRICING from '../services/model-pricing.json'

const MODEL_SNAPSHOT_SUFFIX = /(?:-|@)(?:\d{8}|\d{4}-\d{2}-\d{2})$/
const BEDROCK_VERSION_SUFFIX = /-v\d+(?::\d+)?$/

/** Provider aliases whose billed canonical model is documented and stable. */
const MODEL_PRICING_ALIASES: Record<string, string> = {
  // OpenAI documents gpt-5.6 as the alias for the Sol tier.
  'gpt-5.6': 'gpt-5.6-sol',
  // xAI documents both aliases as pointers to Grok 4.5.
  'grok-4.5-latest': 'grok-4.5',
  'grok-build-latest': 'grok-4.5',
}

/**
 * Return every plausible pricing key for a runtime-reported model id.
 *
 * Provider proxies can report the concrete upstream deployment rather than the
 * configured catalog id, for example:
 *   anthropic/claude-sonnet-5-20260630 -> claude-sonnet-5
 *   anthropic/claude-4.6-opus-20260205 -> claude-opus-4-6
 *   openai/gpt-5.5-20260423            -> openai/gpt-5.5 / gpt-5.5
 *   anthropic/claude-sonnet-4.6         -> claude-sonnet-4-6
 *   claude-haiku-4-5@20251001           -> claude-haiku-4-5
 *
 * Build candidates instead of normalizing destructively so exact custom model
 * ids still win and historical dated ids already present in the static table
 * remain available.
 */
export function modelPricingCandidates(model: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const queue: string[] = []

  const add = (candidate: string) => {
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    candidates.push(candidate)
    queue.push(candidate)
  }

  add(model)

  while (queue.length > 0) {
    const candidate = queue.shift()!

    add(candidate.replace(MODEL_SNAPSHOT_SUFFIX, ''))
    add(candidate.replace(BEDROCK_VERSION_SUFFIX, ''))
    if (MODEL_PRICING_ALIASES[candidate]) add(MODEL_PRICING_ALIASES[candidate])

    if (candidate.includes('/')) {
      add(candidate.split('/').pop()!)
    }

    const bedrockMatch = candidate.match(/^(?:[\w-]+\.)?anthropic\.(.+)$/)
    if (bedrockMatch) add(bedrockMatch[1])

    // OpenRouter uses dots for Claude minor versions (for example,
    // anthropic/claude-sonnet-4.6), while Anthropic's rate-card ids use
    // hyphens. Limit this rewrite to Claude so GPT/Grok decimal versions stay
    // intact.
    if (candidate.startsWith('claude-')) {
      add(candidate.replace(/(\d+)\.(\d+)/g, '$1-$2'))
    }

    // Some proxy responses use Claude's version-family order while our catalog
    // uses family-version. Preserve an optional date so an exact dated static
    // key can still resolve before the undated fallback.
    const claudeVersionFirst = candidate.match(
      /^claude-(\d+(?:[.-]\d+)?)-(haiku|sonnet|opus|fable)(-\d{8})?$/,
    )
    if (claudeVersionFirst) {
      const [, version, family, date = ''] = claudeVersionFirst
      add(`claude-${family}-${version.replace('.', '-')}${date}`)
    }
  }

  return candidates
}

/** Known wire aliases share one override key. Arbitrary private IDs stay exact. */
export function canonicalPricingId(model: string): string {
  const candidates = modelPricingCandidates(model)
  const known = candidates.filter((id) => Object.hasOwn(MODEL_PRICING, id) && !id.includes('/'))
  if (known.length)
    return (
      known.find((id) => !MODEL_SNAPSHOT_SUFFIX.test(id) && !BEDROCK_VERSION_SUFFIX.test(id)) ??
      known[0]
    )
  return model
}
