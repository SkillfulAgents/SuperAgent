/**
 * Authoritative audit of the labels produced by the `label-scopes` workflow.
 *
 * The workflow's in-flight flag check trusts the methods an agent echoes back;
 * this audit re-checks against the on-disk scope-input (the source of truth) and
 * enforces the invariants the codemod depends on:
 *   - coverage:   every scope in scope-input.json has a label
 *   - no extras:  no label references a scope not in scope-input.json
 *   - no read-but-deletes: a 'read' label is never assigned to a scope whose
 *                 endpoints include a DELETE method (the dangerous error — it would
 *                 auto-allow a destructive call under a reads=allow default).
 *                 NOTE: POST is intentionally NOT treated as mutation — APIs use it
 *                 for read queries (search, batch-get, GraphQL, free/busy), and the
 *                 "*" RPC method (Slack) matches any verb, so neither is a signal.
 *
 * Exits non-zero if any hard invariant fails, so it can gate the codemod.
 *
 * Usage: tsx scripts/audit-scope-labels.ts
 *   reads scripts/.scope-input.json and scripts/.scope-labels.json
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const __dirname = dirname(fileURLToPath(import.meta.url))

const scopeInputSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      scopes: z.array(
        z.object({ scope: z.string(), methods: z.array(z.string()) }),
      ),
    }),
  ),
})

const labelsSchema = z.record(
  z.string(),
  z.record(z.string(), z.enum(['read', 'write', 'destructive'])),
)

const input = scopeInputSchema.parse(
  JSON.parse(readFileSync(resolve(__dirname, '.scope-input.json'), 'utf8')),
)
const labels = labelsSchema.parse(
  JSON.parse(readFileSync(resolve(__dirname, '.scope-labels.json'), 'utf8')),
)

const missing: string[] = []
const extras: string[] = []
const readButDeletes: string[] = []

for (const p of input.providers) {
  const provLabels = labels[p.provider] ?? {}
  const inputScopes = new Set(p.scopes.map((s) => s.scope))

  for (const s of p.scopes) {
    const label = provLabels[s.scope]
    if (!label) {
      missing.push(`${p.provider}.${s.scope}`)
      continue
    }
    // Only DELETE is a reliable mutation signal; POST/PUT/PATCH and the "*" RPC
    // method are used for reads too, so they are not flagged here.
    if (label === 'read' && s.methods.includes('DELETE')) {
      readButDeletes.push(`${p.provider}.${s.scope}  (methods: ${s.methods.join(', ')})`)
    }
  }
  for (const scope of Object.keys(provLabels)) {
    if (!inputScopes.has(scope)) extras.push(`${p.provider}.${scope}`)
  }
}

// providers present in labels but absent from input entirely
for (const provider of Object.keys(labels)) {
  if (!input.providers.some((p) => p.provider === provider)) {
    extras.push(`${provider}.* (unknown provider)`)
  }
}

const report = (title: string, items: string[]) => {
  if (items.length === 0) {
    console.log(`✓ ${title}: none`)
  } else {
    console.log(`✗ ${title}: ${items.length}`)
    for (const i of items) console.log(`    ${i}`)
  }
}

const total = input.providers.reduce((n, p) => n + p.scopes.length, 0)
console.log(`Audited ${total} scopes across ${input.providers.length} providers\n`)
report('missing labels (coverage gap)', missing)
report('extra/fabricated scopes (mis-keyed)', extras)
report('read-labeled but appears on a DELETE endpoint', readButDeletes)

const hardFailures = missing.length + extras.length + readButDeletes.length
if (hardFailures > 0) {
  console.error(`\n${hardFailures} hard issue(s) — fix before running the codemod.`)
  process.exit(1)
}
console.log('\nAll invariants hold. Safe to merge into scope-metadata.ts.')
