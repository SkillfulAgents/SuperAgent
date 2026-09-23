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
  // Subscription Messages replies report these concrete deployments (live verified).
  'grok-4.6-build': 'grok-4.6',
  'grok-4.7-build': 'grok-4.7',
}

/**
 * Vendor namespaces that name the same billed model as the bare id
 * (OpenRouter's `openai/gpt-5.5` is Platform's `gpt-5.5`). Any other prefix
 * (`azure/gpt-5.5`, a LiteLLM route, a private deployment) is somebody's own
 * deployment: it may fall back to the bare model's rate when it has none, but
 * it never shares an override key with it. `model-pricing-ids.test.ts` checks
 * every slash-qualified built-in id against this list.
 */
export const VENDOR_PREFIXES: ReadonlySet<string> = new Set([
  'anthropic',
  'deepseek',
  'moonshotai',
  'openai',
  'x-ai',
  'z-ai',
])

const CANDIDATE_CACHE_LIMIT = 2000
const candidateCache = new Map<string, readonly string[]>()

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
export function modelPricingCandidates(
  model: string,
  options: { vendorPrefixesOnly?: boolean } = {},
): readonly string[] {
  // The expansion is pure and a load sees a handful of distinct ids, while the
  // catalog and the usage loader ask for the same ones over and over.
  const cacheKey = `${options.vendorPrefixesOnly ? 'v' : 'a'}:${model}`
  const cached = candidateCache.get(cacheKey)
  if (cached) return cached

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
    // hasOwn: a runtime id is arbitrary text, and `constructor` is not an alias.
    if (Object.hasOwn(MODEL_PRICING_ALIASES, candidate)) add(MODEL_PRICING_ALIASES[candidate])

    const slash = candidate.lastIndexOf('/')
    if (
      slash !== -1 &&
      (!options.vendorPrefixesOnly || VENDOR_PREFIXES.has(candidate.slice(0, slash)))
    ) {
      add(candidate.slice(slash + 1))
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

  if (candidateCache.size >= CANDIDATE_CACHE_LIMIT) candidateCache.clear()
  candidateCache.set(cacheKey, candidates)
  return candidates
}

/**
 * The key a price override is WRITTEN under. Known wire aliases (snapshot
 * dates, Bedrock ids, vendor namespaces) share one key; arbitrary private ids,
 * including a foreign prefix in front of a known model, stay exact. Reads go
 * through `findGlobalPrice`, which probes every candidate most-specific-first.
 */
export function canonicalPricingId(model: string): string {
  const candidates = modelPricingCandidates(model, { vendorPrefixesOnly: true })
  const known = candidates.filter((id) => Object.hasOwn(MODEL_PRICING, id) && !id.includes('/'))
  if (known.length)
    return (
      known.find((id) => !MODEL_SNAPSHOT_SUFFIX.test(id) && !BEDROCK_VERSION_SUFFIX.test(id)) ??
      known[0]
    )
  return model
}
