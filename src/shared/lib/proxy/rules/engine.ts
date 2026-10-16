/**
 * Proxy rule evaluation and draft validation.
 *
 * A rule applies when one of its patterns matches the request. Its code
 * answers one question for both effects: is this request fine without
 * review? Only a literal `true` means yes; false, a throw, a timeout or a
 * non-boolean all mean review.
 *   - `require` rules run on every request the policy does not block. Every
 *     matching one must return true, or the request goes to review — even when
 *     the policy would allow it, and whatever any allow rule says.
 *   - `allow` rules run only on requests the policy sends to review, and only
 *     when no require rule held the request. They are OR'd: the first that
 *     returns true allows it.
 *   - Nothing changes a policy `block`.
 */
import { createHash } from 'node:crypto'
import { SCOPE_MAPS } from '../scope-maps'
import { getScopeLabel, type ScopeLabel } from '../scope-metadata'
import type { McpToolInfo } from '@shared/lib/mcp/types'
import {
  matchesAnyApiPattern,
  matchesAnyToolPattern,
  matchesApiPattern,
  parseApiPattern,
  validateToolPattern,
  type ParsedApiPattern,
} from './patterns'
import { checkRuleSyntax, runRule, runRuleOnJson, serializeRuleInput, type RuleOutcome } from './sandbox'
import type { ApiRuleInput, McpRuleInput, RuleInput } from './input'

export type RuleKind = 'api' | 'mcp'

export type RuleEffect = 'allow' | 'require'

export function isRuleEffect(value: unknown): value is RuleEffect {
  return value === 'allow' || value === 'require'
}

export type RuleEvaluationOutcome = RuleOutcome | { result: 'schema_changed' } | { result: 'budget_exceeded' }

/** Most live rules one connection can have. */
export const MAX_RULES_PER_TARGET = 20
/** Time one request may spend on rules; rules not reached in time answer "review". */
export const REQUEST_RULE_BUDGET_MS = 250
/** Time one draft's tests and probes may take before validation stops. */
const VALIDATION_BUDGET_MS = 2_000

export interface ActiveRule {
  ruleId: string
  versionId: string
  version: number
  kind: RuleKind
  effect: RuleEffect
  name: string
  restatement: string
  patterns: string[]
  code: string
  toolSchemaHash: string | null
}

export interface RuleEvaluation {
  ruleId: string
  versionId: string
  version: number
  effect: RuleEffect
  name: string
  restatement: string
  outcome: RuleEvaluationOutcome
  durationMs: number
}

export type PolicyOutcome = 'allow' | 'review'

export interface RulesResult {
  decision: PolicyOutcome
  /** The allow rule that moved the request from review to allow. */
  allowedBy: RuleEvaluation | null
  /** The require rule that held the request for review. */
  heldBy: RuleEvaluation | null
  evaluations: RuleEvaluation[]
}

/** What a rule's patterns are matched against, before the body is read. */
export type RuleMatch = { kind: 'api'; method: string; path: string } | { kind: 'mcp'; tool: string }

export function ruleApplies(rule: ActiveRule, match: RuleMatch): boolean {
  if (match.kind === 'api') return rule.kind === 'api' && matchesAnyApiPattern(rule.patterns, match.method, match.path)
  return rule.kind === 'mcp' && matchesAnyToolPattern(rule.patterns, match.tool)
}

/** The rules that can change the outcome of a request the policy decided. */
export function relevantRules(rules: ActiveRule[], match: RuleMatch, policy: PolicyOutcome): ActiveRule[] {
  return rules.filter((rule) => (rule.effect === 'require' || policy === 'review') && ruleApplies(rule, match))
}

/**
 * Decide a request the policy allowed or sent to review: require rules first
 * (stopping at the first that holds it), then, for a reviewed request, allow
 * rules (stopping at the first that allows it). The input is serialized once
 * for every rule. Rules not reached within the request's time budget answer
 * "review" (`budget_exceeded`). `currentToolSchemaHash` recomputes an MCP
 * rule's schema hash against the server's current tool list; a mismatch means
 * the tool changed since the rule was confirmed, so the rule's answer is
 * "review".
 */
export async function evaluateRules(
  rules: ActiveRule[],
  input: RuleInput,
  policy: PolicyOutcome,
  options: { currentToolSchemaHash?: (patterns: string[]) => string | null; budgetMs?: number } = {},
): Promise<RulesResult> {
  const evaluations: RuleEvaluation[] = []
  const applicable = relevantRules(rules, input, policy)
  if (applicable.length === 0) return { decision: policy, allowedBy: null, heldBy: null, evaluations }
  const inputJson = serializeRuleInput(input)
  const deadline = performance.now() + (options.budgetMs ?? REQUEST_RULE_BUDGET_MS)
  const evaluate = (rule: ActiveRule) => evaluateRule(rule, inputJson, deadline, options)
  for (const rule of applicable.filter((r) => r.effect === 'require')) {
    const evaluation = await evaluate(rule)
    evaluations.push(evaluation)
    if (evaluation.outcome.result !== 'true') return { decision: 'review', allowedBy: null, heldBy: evaluation, evaluations }
  }
  if (policy === 'allow') return { decision: 'allow', allowedBy: null, heldBy: null, evaluations }
  for (const rule of applicable.filter((r) => r.effect === 'allow')) {
    const evaluation = await evaluate(rule)
    evaluations.push(evaluation)
    if (evaluation.outcome.result === 'true') return { decision: 'allow', allowedBy: evaluation, heldBy: null, evaluations }
  }
  return { decision: 'review', allowedBy: null, heldBy: null, evaluations }
}

async function evaluateRule(
  rule: ActiveRule,
  inputJson: string | RuleOutcome,
  deadline: number,
  options: { currentToolSchemaHash?: (patterns: string[]) => string | null },
): Promise<RuleEvaluation> {
  const started = performance.now()
  let outcome: RuleEvaluationOutcome
  if (started >= deadline) {
    outcome = { result: 'budget_exceeded' }
  } else if (typeof inputJson !== 'string') {
    outcome = inputJson
  } else if (rule.kind === 'mcp' && rule.toolSchemaHash && options.currentToolSchemaHash
    && options.currentToolSchemaHash(rule.patterns) !== rule.toolSchemaHash) {
    outcome = { result: 'schema_changed' }
  } else {
    outcome = await runRuleOnJson(rule.code, inputJson)
  }
  return {
    ruleId: rule.ruleId,
    versionId: rule.versionId,
    version: rule.version,
    effect: rule.effect,
    name: rule.name,
    restatement: rule.restatement,
    outcome,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  }
}

/** Hash of the input schemas of every tool the patterns match. */
export function toolSchemaHash(patterns: string[], tools: McpToolInfo[]): string {
  const matched = tools
    .filter((tool) => matchesAnyToolPattern(patterns, tool.name))
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return createHash('sha256').update(stableStringify(matched)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

export interface RuleTestCase {
  name: string
  /** Partial request; unspecified fields get neutral defaults. */
  input: Record<string, unknown>
  expect: boolean
}

export interface RuleDraft {
  kind: RuleKind
  effect: RuleEffect
  description: string
  patterns: string[]
  code: string
  tests: RuleTestCase[]
}

export interface RuleTestResult {
  name: string
  expect: boolean
  outcome: RuleEvaluationOutcome
  passed: boolean
  error?: string
}

export interface CoveredEndpoint {
  method: string
  path: string
  description?: string
  label?: ScopeLabel
}

export interface RuleDraftReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  testResults: RuleTestResult[]
  /** Known endpoints (api) or current tools (mcp) the patterns cover. */
  coverage: CoveredEndpoint[] | string[]
  toolSchemaHash: string | null
}

export const TEST_NOW = { iso: '2026-01-15T17:00:00.000Z', epochMs: Date.parse('2026-01-15T17:00:00.000Z') }

export function testCaseInput(kind: RuleKind, raw: Record<string, unknown>): RuleInput {
  if (kind === 'mcp') {
    return {
      kind: 'mcp',
      tool: typeof raw.tool === 'string' ? raw.tool : '',
      args: raw.args ?? null,
      argsTruncated: raw.argsTruncated === true,
      now: (raw.now as McpRuleInput['now']) ?? TEST_NOW,
    }
  }
  const headers = { ...((raw.headers as Record<string, string>) ?? {}) }
  let contentType = typeof raw.contentType === 'string' ? raw.contentType : headers['content-type'] ?? null
  let body: unknown = raw.body ?? null
  let bodyText = typeof raw.bodyText === 'string' ? raw.bodyText : null
  if (body !== null && bodyText === null) {
    bodyText = JSON.stringify(body)
    contentType ??= 'application/json'
  } else if (bodyText !== null && body === null && (contentType ?? '').includes('json')) {
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = null
    }
  }
  if (contentType) headers['content-type'] = contentType
  const path = typeof raw.path === 'string' ? raw.path : '/'
  const input: ApiRuleInput = {
    kind: 'api',
    method: typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET',
    host: typeof raw.host === 'string' ? raw.host : '',
    path: path.startsWith('/') ? path : `/${path}`,
    query: (raw.query as ApiRuleInput['query']) ?? {},
    headers,
    contentType,
    body,
    bodyText,
    bodyTruncated: raw.bodyTruncated === true,
    now: (raw.now as ApiRuleInput['now']) ?? TEST_NOW,
  }
  return input
}

/**
 * Whether two patterns can match a common request. Approximated by matching
 * each against a concrete instance of the other, which covers a rule narrower
 * than a catalog entry (a literal `primary` segment vs a wildcard segment) and
 * one wider than it (`**` vs anything).
 */
function patternsOverlap(a: ParsedApiPattern, b: ParsedApiPattern): boolean {
  const methods = a.method === '*' ? (b.method === '*' ? ['POST'] : [b.method]) : [a.method]
  return methods.some((method) =>
    (matchesApiPattern(a, method, concretePath(b.segments)) && (b.method === '*' || b.method === method))
    || (matchesApiPattern(b, method, concretePath(a.segments)) && (a.method === '*' || a.method === method)))
}

function concretePath(segments: string[]): string {
  return '/' + segments.filter((s) => s !== '**').map((s) => (s.includes('*') ? s.replace(/\*/g, 'x') : s)).join('/')
}

/**
 * An endpoint's risk is that of the narrowest scope sufficient for it
 * (messages.send is a 'write' via gmail.send even though gmail.full, also
 * sufficient, is 'destructive').
 */
function endpointLabel(toolkit: string, scopes: string[]): ScopeLabel | undefined {
  const order: ScopeLabel[] = ['read', 'write', 'destructive']
  let narrowest: ScopeLabel | undefined
  for (const scope of scopes) {
    const label = getScopeLabel(toolkit, scope)
    if (label && (!narrowest || order.indexOf(label) < order.indexOf(narrowest))) narrowest = label
  }
  return narrowest
}

/**
 * Check a draft before a person is asked to confirm it. Errors block saving;
 * warnings are shown on the confirmation card.
 */
export async function validateRuleDraft(
  draft: RuleDraft,
  context: { toolkit?: string; tools?: McpToolInfo[] } = {},
): Promise<RuleDraftReport> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!draft.description.trim()) errors.push('A description is required.')
  if (draft.patterns.length === 0) errors.push('At least one pattern is required.')
  if (draft.patterns.length > 50) errors.push('At most 50 patterns are allowed.')
  if (draft.code.length > 20_000) errors.push('Rule code must be under 20,000 characters.')
  if (draft.tests.length === 0) errors.push('At least one test case is required.')
  if (draft.tests.length > 100) errors.push('At most 100 test cases are allowed.')
  if (!draft.tests.some((t) => t.expect === true)) errors.push('Include at least one test that is fine without review (expect: true).')
  if (!draft.tests.some((t) => t.expect === false)) errors.push('Include at least one test that goes to review (expect: false).')

  for (const pattern of draft.patterns) {
    if (draft.kind === 'api') {
      const parsed = parseApiPattern(pattern)
      if (!parsed.ok) errors.push(parsed.error)
    } else {
      const problem = validateToolPattern(pattern)
      if (problem) errors.push(problem)
    }
  }

  const syntaxError = checkRuleSyntax(draft.code)
  if (syntaxError) errors.push(`Code does not compile: ${syntaxError}`)

  // Coverage: which known endpoints / tools the patterns reach.
  let coverage: CoveredEndpoint[] | string[] = []
  let schemaHash: string | null = null
  if (draft.kind === 'api' && context.toolkit && SCOPE_MAPS[context.toolkit]) {
    const covered: CoveredEndpoint[] = []
    for (const entry of SCOPE_MAPS[context.toolkit].scopeMap) {
      const entryPattern = parseApiPattern(`${entry.method} ${entry.pathPattern}`)
      if (!entryPattern.ok) continue
      const hit = draft.patterns.some((raw) => {
        const parsed = parseApiPattern(raw)
        return parsed.ok && patternsOverlap(parsed.pattern, entryPattern.pattern)
      })
      if (hit) {
        covered.push({
          method: entry.method,
          path: entry.pathPattern,
          description: entry.description,
          label: endpointLabel(context.toolkit, entry.sufficientScopes),
        })
      }
    }
    coverage = covered
    if (covered.length === 0) {
      warnings.push(`The patterns match no endpoint in the ${context.toolkit} catalog; check the paths.`)
    }
    const labels = new Set(covered.map((c) => c.label).filter(Boolean))
    if (labels.has('destructive')) warnings.push('The patterns cover destructive endpoints.')
    if (labels.size > 1) warnings.push(`The patterns span several risk levels (${[...labels].join(', ')}).`)
  } else if (draft.kind === 'mcp' && context.tools) {
    const names = context.tools.filter((t) => matchesAnyToolPattern(draft.patterns, t.name)).map((t) => t.name)
    coverage = names
    if (names.length === 0) warnings.push('The patterns match none of the server\'s current tools.')
    schemaHash = toolSchemaHash(draft.patterns, context.tools)
  }

  // Tests: each must reach the rule (match a pattern), finish in time and
  // produce `expect`. A rule that times out on any input is broken whatever
  // the test expected, so validation stops there — as it does once the whole
  // draft has used its time budget.
  const testResults: RuleTestResult[] = []
  if (!syntaxError) {
    const deadline = performance.now() + VALIDATION_BUDGET_MS
    let stopped: string | null = null
    for (const test of draft.tests) {
      if (performance.now() >= deadline) {
        stopped = `Validation stopped after ${testResults.length} of ${draft.tests.length} test cases: the rule is too slow.`
        break
      }
      const input = testCaseInput(draft.kind, test.input ?? {})
      const reaches = input.kind === 'api'
        ? matchesAnyApiPattern(draft.patterns, input.method, input.path)
        : matchesAnyToolPattern(draft.patterns, input.tool)
      const outcome = await runRule(draft.code, input, { pool: 'validate' })
      const allowed = outcome.result === 'true'
      const result: RuleTestResult = {
        name: test.name,
        expect: test.expect,
        outcome,
        passed: reaches && outcome.result !== 'timeout' && allowed === test.expect,
      }
      if (!reaches) result.error = 'This request matches none of the rule\'s patterns, so the rule would never see it.'
      else if (outcome.result === 'timeout') result.error = `The rule took longer than its time limit on this input.`
      testResults.push(result)
      if (outcome.result === 'timeout') {
        stopped = `Validation stopped at "${test.name}": the rule must finish quickly on every input.`
        break
      }
    }
    const failed = testResults.filter((r) => !r.passed)
    if (failed.length > 0) errors.push(`${failed.length} of ${testResults.length} test cases failed.`)
    if (stopped) errors.push(stopped)

    // Generic probes: a write the rule allows with an empty or missing body is
    // usually a vacuous check (e.g. [].every(...) === true).
    if (!stopped) {
      for (const probe of emptyProbes(draft)) {
        if (performance.now() >= deadline) break
        if ((await runRule(draft.code, probe.input, { pool: 'validate' })).result !== 'true') continue
        warnings.push(draft.effect === 'allow' ? `Allows ${probe.label}.` : `Lets ${probe.label} through without review.`)
      }
    }
  }

  if (draft.effect === 'require') {
    warnings.push('A require rule only holds requests its patterns match. The same action through another endpoint or tool the policy allows is not held.')
  }

  return { ok: errors.length === 0, errors, warnings, testResults, coverage, toolSchemaHash: schemaHash }
}

function emptyProbes(draft: RuleDraft): Array<{ label: string; input: RuleInput }> {
  const probes: Array<{ label: string; input: RuleInput }> = []
  if (draft.kind === 'mcp') {
    for (const pattern of draft.patterns) {
      const tool = pattern.replace(/\*/g, 'x')
      probes.push({ label: `a ${tool} call with no arguments`, input: testCaseInput('mcp', { tool, args: {} }) })
    }
    return probes
  }
  for (const raw of draft.patterns) {
    const parsed = parseApiPattern(raw)
    if (!parsed.ok) continue
    const method = parsed.pattern.method === '*' ? 'POST' : parsed.pattern.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') continue
    const path = concretePath(parsed.pattern.segments)
    probes.push({ label: `an empty-body ${method} ${path}`, input: testCaseInput('api', { method, path }) })
    probes.push({ label: `a ${method} ${path} with body {}`, input: testCaseInput('api', { method, path, body: {} }) })
  }
  return probes
}
