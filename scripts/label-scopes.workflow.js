/**
 * label-scopes workflow
 * ──────────────────────
 * Classifies every OAuth scope in the codebase as read | write | destructive.
 *
 * This file is NOT a standalone node script — it runs via the Workflow tool,
 * which provides the agent()/pipeline()/phase()/log() globals. It is plain JS
 * on purpose (the Workflow runtime rejects TS syntax).
 *
 * Input (passed as `args` when launching):
 *   { inputPath: absolute path to scripts/.scope-input.json, providers: string[] }
 * The full, rich per-scope data (descriptions + sample endpoints, ~670KB) is too
 * large to inline, so each agent READS its own provider's slice from inputPath.
 * The in-flight flag check (stage 2) uses the methods the agent echoes back;
 * an AUTHORITATIVE audit against the on-disk methods + a 100%-coverage check are
 * done post-hoc by the orchestrator (which has disk access), so this workflow
 * needs nothing inline beyond the provider name list.
 *
 * Output (returned to the orchestrator):
 *   { labels: { [provider]: { [scope]: 'read'|'write'|'destructive' } },
 *     counts, lowConfidence: [...], reclassified: [...], missing: [...] }
 *
 * Pipeline, per provider (no barrier between providers):
 *   1. Classify — one agent reads the slice and labels every scope.
 *   2. Re-judge — a deterministic check on the result flags scopes that look
 *      UNDER-rated (read label + mutating method, destructive-sounding rationale,
 *      or low confidence); only those go back for a second, risk-biased pass.
 */

export const meta = {
  name: 'label-scopes',
  description: 'Classify every OAuth scope as read | write | destructive',
  phases: [
    { title: 'Classify', detail: 'one agent per provider reads its slice and labels every scope' },
    { title: 'Re-judge', detail: 'risk-biased re-check of flagged/contradictory scopes' },
  ],
}

// ── Shared rubric ────────────────────────────────────────────────────────────
const RUBRIC = `Classify each OAuth/API scope into exactly one of: read | write | destructive,
based on the capability it grants. These labels drive default access policies:
read → auto-allow, write → ask the user for review, destructive → block by default.
So "destructive" is a NARROW, reserved bucket — not "anything that can change data".

- "read": only lets the holder view / list / get / search / export data. No creation,
  modification, or deletion of anything. NOTE: many APIs use POST for read-style queries
  (search, batch-get, GraphQL, free/busy lookups), so POST does NOT prove writing — judge
  by what the scope NAME and DESCRIPTION actually do.

- "write": ordinary, expected content operations — create, update, edit, send, upload,
  comment, and DELETING INDIVIDUAL CONTENT ITEMS (one task, file, message, record, event,
  comment). This is the default for "*.write" / "read-write" content scopes, EVEN WHEN
  they can delete single items. Routine, reversible-in-spirit work on content.

- "destructive": reserve ONLY for:
  (a) Irreversible or bulk destruction — permanent delete / purge / "delete all" / empty
      trash / delete an ENTIRE container or account (delete repo, delete project, delete
      workspace, delete account); data that cannot be recovered.
  (b) Administrative / governance power over the account, org, or OTHER users (not your
      own content) — managing members/users/groups/roles/permissions, billing, org or
      enterprise admin, security settings, legal hold, data retention, audit logs,
      impersonation/sudo, transferring ownership, and full/superuser/unrestricted scopes
      ("*.full", "root_readwrite", broad "api").

Decision aids:
- A "*.write" or "read/write" scope for ORDINARY CONTENT (tasks, files, records, messages,
  comments, issues, calendars, drafts) → write, even though it can delete individual items.
- "manage" alone is NOT destructive. "manage tasks/files/content" = write; "manage
  members/users/roles/permissions/billing" = destructive.
- Keywords that signal destructive: permanent, purge, irreversible, "delete all", empty
  trash, delete repo/project/workspace/account, admin, sudo, impersonate, billing, legal
  hold, retention, audit log, full access, superuser, transfer ownership.
- HTTP methods are a WEAK hint (POST is used for reads). The scope NAME + DESCRIPTION are
  authoritative. Only a DELETE that wipes a whole container or is explicitly permanent
  points to destructive; deleting one item is write.
- TIE-BREAKERS: when torn between read and write, choose write. When torn between write and
  destructive, choose WRITE — unless it clearly matches (a) or (b) above. Mark confidence
  "low" on any genuinely close call so it gets a second look.
- Copy the \`scope\` identifier VERBATIM (character-for-character) from the input. NEVER use
  the description text as the scope id.`

// ── Structured output schema (forced on each classifier agent) ───────────────
const LABELS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'labels'],
  properties: {
    provider: { type: 'string' },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'label', 'confidence', 'methods', 'rationale'],
        properties: {
          scope: { type: 'string' },
          label: { type: 'string', enum: ['read', 'write', 'destructive'] },
          confidence: { type: 'string', enum: ['high', 'low'] },
          // copied verbatim from the slice; lets us correlate without a re-read
          methods: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

// Exact command an agent runs to pull its provider's rich slice from disk.
function sliceCommand(inputPath, provider) {
  return (
    `node -e "const d=require('${inputPath}');` +
    `const p=d.providers.find(x=>x.provider==='${provider}');` +
    `process.stdout.write(JSON.stringify(p?p.scopes:[]))"`
  )
}

// ── Deterministic flag detector (no LLM) ─────────────────────────────────────
// Flags only genuine UNDER-classification of destructive (admin/permanent power
// labeled read/write) and reads that touch a real DELETE. POST and the "*" RPC
// method are NOT treated as mutation (POST is used for reads). The re-judge that
// follows is NEUTRAL — it re-applies the rubric, it does not bias upward.
function flagSuspicious(classified) {
  const out = []
  for (const l of classified) {
    const methods = l.methods || []
    const hasDelete = methods.includes('DELETE')
    const text = `${l.rationale || ''}`.toLowerCase()
    // narrow keyword set matching the destructive (a)/(b) definition — deliberately
    // does NOT match bare "delete" (deleting one item is write)
    const soundsDestructive =
      /permanent|purge|irreversibl|delete all|empty trash|delete (the |a |an |entire )?(repo|project|workspace|account|organi[sz]ation|org\b)|manage (member|user|group|role|permission|access)|billing|legal.?hold|retention|audit log|impersonat|\bsudo\b|full access|super.?user|transfer owner/.test(
        text,
      )

    const readWithDelete = l.label === 'read' && hasDelete
    const underRatedDestructive = l.label !== 'destructive' && soundsDestructive
    const lowConfidence = l.confidence === 'low'

    if (readWithDelete || underRatedDestructive || lowConfidence) {
      out.push({
        scope: l.scope,
        currentLabel: l.label,
        methods,
        reason: readWithDelete
          ? 'labeled read but appears on a DELETE endpoint'
          : underRatedDestructive
            ? 'rationale mentions admin/irreversible/bulk power but label is not destructive'
            : 'classifier marked low confidence',
      })
    }
  }
  return out
}

// ── Run ──────────────────────────────────────────────────────────────────────
// `args` normally arrives as a parsed object, but can reach the script as a JSON
// string depending on how it was passed — accept either.
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch {
    throw new Error('label-scopes: args was a string but not valid JSON')
  }
}
if (!input || !input.inputPath || !Array.isArray(input.providers)) {
  throw new Error(
    `label-scopes: expected args = { inputPath, providers: string[] }, got: ${JSON.stringify(input)?.slice(0, 200)}`,
  )
}
const providers = [...input.providers].sort()
log(`Classifying ${providers.length} providers`)

const perProvider = await pipeline(
  providers,

  // Stage 1 — read the slice from disk, classify every scope
  (provider) =>
    agent(
      `${RUBRIC}\n\nProvider: ${provider}\n\n` +
        `First, read this provider's scope data by running exactly:\n` +
        `${sliceCommand(input.inputPath, provider)}\n\n` +
        `That prints a JSON array of N objects { scope, description, methods, sampleEndpoints }. ` +
        `Return EXACTLY N entries — one per input object, in the same order, NONE skipped or ` +
        `merged. For each, set \`scope\` to the input object's \`scope\` string copied ` +
        `character-for-character (do NOT use the description as the scope id), and copy its ` +
        `\`methods\` array verbatim. Then assign the label per the rubric.`,
      { label: `classify:${provider}`, phase: 'Classify', schema: LABELS_SCHEMA },
    ),

  // Stage 2 — deterministic flag, then re-judge only the flagged scopes (risk-biased)
  (classifiedResult, provider) => {
    const classified = classifiedResult?.labels ?? []
    const flagged = flagSuspicious(classified)
    if (flagged.length === 0) {
      return { provider, labels: classified, reclassified: [] }
    }
    const flaggedScopes = flagged.map((f) => f.scope)
    return agent(
      `${RUBRIC}\n\nProvider: ${provider}\n\n` +
        `A first pass labeled this provider's scopes; an automated check flagged the ones ` +
        `below for a second look (often the rationale mentioned delete/manage). Read the ` +
        `full scope data:\n` +
        `${sliceCommand(input.inputPath, provider)}\n\n` +
        `Re-apply the rubric to ONLY these flagged scopes and return the CORRECT label for ` +
        `each (one entry per flagged scope, scope id copied verbatim). Do not bias up or ` +
        `down — many flags are false alarms (e.g. a content scope that can delete a single ` +
        `item is "write", not "destructive"). Only "destructive" if it matches definition ` +
        `(a) irreversible/bulk destruction or (b) admin/governance power.\n\n` +
        `Flagged scopes: ${JSON.stringify(flaggedScopes)}\n` +
        `Flag details:\n${JSON.stringify(flagged, null, 1)}`,
      { label: `recheck:${provider}`, phase: 'Re-judge', schema: LABELS_SCHEMA },
    ).then((rejudged) => {
      const override = new Map((rejudged?.labels ?? []).map((l) => [l.scope, l]))
      const merged = classified.map((l) => override.get(l.scope) ?? l)
      return {
        provider,
        labels: merged,
        reclassified: [...override.values()].map((l) => ({ scope: l.scope, to: l.label })),
      }
    })
  },
)

// ── Assemble (plain JS, deterministic) ───────────────────────────────────────
const labels = {}
const lowConfidence = []
const reclassified = []
const counts = { read: 0, write: 0, destructive: 0 }

for (const res of perProvider.filter(Boolean)) {
  const provider = res.provider
  labels[provider] = {}
  for (const l of res.labels) {
    if (!l || !l.scope || !Object.prototype.hasOwnProperty.call(counts, l.label)) continue
    labels[provider][l.scope] = l.label
    counts[l.label]++
    if (l.confidence === 'low') lowConfidence.push({ provider, scope: l.scope, label: l.label })
  }
  for (const r of res.reclassified ?? []) reclassified.push({ provider, ...r })
}

log(
  `Done. read=${counts.read} write=${counts.write} destructive=${counts.destructive}; ` +
    `${lowConfidence.length} low-confidence, ${reclassified.length} reclassified ` +
    `(coverage + authoritative method audit run post-hoc)`,
)

return { labels, counts, lowConfidence, reclassified }
