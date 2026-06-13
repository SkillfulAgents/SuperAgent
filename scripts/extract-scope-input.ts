/**
 * Extract a deterministic, agent-friendly classification input for the
 * `label-scopes` workflow.
 *
 * For every provider in SCOPE_MAPS, and every scope in its `allScopes`, we
 * collect:
 *   - the curated description (from SCOPE_DESCRIPTIONS), if any
 *   - the union of HTTP methods across endpoints that accept this scope
 *   - a few sample endpoints (method + path + description)
 *
 * The HTTP-method set is the strongest objective signal for read/write/
 * destructive classification (GET-only ⇒ read; DELETE ⇒ destructive candidate),
 * so we hand it to the agents pre-computed rather than make them parse the
 * 4,500-line scope-maps file themselves.
 *
 * Output is sorted (providers + scopes alphabetically) so re-runs are stable
 * and the workflow's result cache stays valid.
 *
 * Usage: tsx scripts/extract-scope-input.ts [outfile]
 *   default outfile: scripts/.scope-input.json (gitignored working artifact)
 */
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { SCOPE_MAPS } from '../src/shared/lib/proxy/scope-maps'
import { SCOPE_METADATA } from '../src/shared/lib/proxy/scope-metadata'

const MAX_SAMPLE_ENDPOINTS = 6
const MAX_DESC_LEN = 160

interface SampleEndpoint {
  method: string
  pathPattern: string
  description?: string
}

interface ScopeInput {
  scope: string
  description?: string
  /** Union of HTTP methods across endpoints whose sufficientScopes include this scope. */
  methods: string[]
  sampleEndpoints: SampleEndpoint[]
}

interface ProviderInput {
  provider: string
  apiHost: string
  scopeCount: number
  scopes: ScopeInput[]
}

function flattenAllScopes(allScopes: string[] | Record<string, string[]>): string[] {
  return Array.isArray(allScopes) ? allScopes : Object.values(allScopes).flat()
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'
}

const providers: ProviderInput[] = []

for (const providerKey of Object.keys(SCOPE_MAPS).sort()) {
  const map = SCOPE_MAPS[providerKey]
  const curated = SCOPE_METADATA[providerKey] ?? {}
  const allScopes = [...new Set(flattenAllScopes(map.allScopes))].sort()

  const scopes: ScopeInput[] = allScopes.map((scope) => {
    const methodSet = new Set<string>()
    const samples: SampleEndpoint[] = []
    const seenSample = new Set<string>()

    // Endpoints with descriptions first, so samples carry the most signal.
    const entries = [...map.scopeMap].sort(
      (a, b) => Number(Boolean(b.description)) - Number(Boolean(a.description)),
    )

    for (const entry of entries) {
      if (!entry.sufficientScopes.includes(scope)) continue
      methodSet.add(entry.method)
      const key = `${entry.method} ${entry.pathPattern}`
      if (samples.length < MAX_SAMPLE_ENDPOINTS && !seenSample.has(key)) {
        seenSample.add(key)
        samples.push({
          method: entry.method,
          pathPattern: entry.pathPattern,
          description: truncate(entry.description, MAX_DESC_LEN),
        })
      }
    }

    return {
      scope,
      description: curated[scope]?.description,
      methods: [...methodSet].sort(),
      sampleEndpoints: samples,
    }
  })

  providers.push({
    provider: providerKey,
    apiHost: map.apiHost,
    scopeCount: scopes.length,
    scopes,
  })
}

const totalScopes = providers.reduce((n, p) => n + p.scopeCount, 0)
const withDesc = providers.reduce(
  (n, p) => n + p.scopes.filter((s) => s.description).length,
  0,
)
const withMethods = providers.reduce(
  (n, p) => n + p.scopes.filter((s) => s.methods.length > 0).length,
  0,
)

const output = {
  generatedFrom: 'src/shared/lib/proxy/scope-maps.ts + scope-descriptions.ts',
  providerCount: providers.length,
  totalScopes,
  providers,
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outfile = resolve(__dirname, process.argv[2] ?? '.scope-input.json')
writeFileSync(outfile, JSON.stringify(output, null, 2))

console.log(`Wrote ${outfile}`)
console.log(`  providers:        ${providers.length}`)
console.log(`  scopes (total):   ${totalScopes}`)
console.log(`  with description: ${withDesc}/${totalScopes}`)
console.log(`  with ≥1 method:   ${withMethods}/${totalScopes}`)
console.log('')
console.log('Per-provider scope counts:')
for (const p of providers) {
  console.log(`  ${p.provider.padEnd(20)} ${String(p.scopeCount).padStart(4)}`)
}
