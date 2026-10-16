import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from '../agents/host-client'

/**
 * Proxy rules: JavaScript predicates that either let specific API / MCP
 * requests skip the user's manual review (allow) or hold them for review even
 * when the policy allows them (require). The host validates each rule against
 * its own test cases, has it described independently from its code, and asks
 * the user to approve it before saving.
 */

async function callRulesHost(op: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown }> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  if (!baseUrl || !token) return { ok: false, status: 500, data: { error: 'Host API is not configured in this container.' } }
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/x-agent/rules/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    let data: unknown = null
    try {
      data = await response.json()
    } catch {
      data = { error: `HTTP ${response.status}` }
    }
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, data: { error: `Network error: ${error instanceof Error ? error.message : String(error)}` } }
  }
}

function jsonResult(result: { ok: boolean; data: unknown }) {
  return textResult(JSON.stringify(result.data, null, 2), !result.ok)
}

const SEMANTICS = `How rules work:
- A denied or timed-out request's response names the rules that ran and what each decided (not their code).
- A rule's code answers one question: is this request fine without the user's review? Only a literal true means yes; anything else (false, throw, timeout over 50 ms, non-boolean) means review. A rule runs only when one of its patterns matches, and has an effect:
  - "allow" (default): runs on requests the account's policy sends to review; true lets the request through. Allow rules are OR'd.
  - "require": runs on requests the policy lets through too; anything but true sends the request to review, and no allow rule can override that. A require rule only holds what its patterns match, so cover every endpoint or tool that performs the action.
  Neither effect changes a request the policy blocks.
- The code is a single JavaScript function expression (req, h) => boolean, run synchronously in a sandbox: no network, no require/process/eval, frozen input, no state between calls. Return false whenever a field you need is missing or malformed — an empty recipient list must not pass .every().
- Before submitting, research the API's real request shapes (docs, or the requests you have been making) and cover every endpoint variant that performs the action, and nothing wider.
- Tests are partial req objects plus the expected boolean. Include adversarial cases a careless rule gets wrong (display-name tricks like "a@acme.com" <x@evil.com>, lookalike domains such as evilacme.com, mixed recipients, missing/empty fields, numbers as strings, boundary values). At least one test must expect true and one false, and every test must match a pattern. The host runs them; a failing draft is returned to you with the failures and never reaches the user.
- The user sees a short name and a plain-English description, both generated independently from your code (not from your description), your tests and their results, and the endpoints your patterns cover, then approves or rejects. This call blocks until they decide (up to 5 minutes).
- Create rules when the user asks for one, or offer to when they keep approving the same kind of request. Never create a rule to get around a request the user denied.

Helpers (h): h.decodeBase64(s) → UTF-8 string or null; h.parseMessage(raw) → { headers, body, header(name), headerAll(name) } or null (RFC 5322/MIME); h.parseAddressList(value) → [{ name, address, local, domain, group }] | [] | null; h.recipients(rawOrParsed) → every To/Cc/Bcc/Resent-* address or null; h.domainOf(address) → domain or null; h.domainMatches(domain, base, { subdomains }) → exact match (evilacme.com never matches acme.com); h.toNumber(v) → finite number from a number or plain decimal string, else null.`

const API_INPUT = `API rules receive req = { kind: 'api', method, host, path (as forwarded, no query), query: {k: v | v[]}, headers (lowercased, no credentials), contentType, body (parsed JSON or form object, else null), bodyText (UTF-8 text or null), bodyTruncated, now: { iso, epochMs } }.
Patterns are "METHOD /path": METHOD is an HTTP verb or *; * matches one path segment (may be partial, e.g. msg*), ** matches zero or more segments; the query string is not matched.`

const MCP_INPUT = `MCP rules receive req = { kind: 'mcp', tool, args (the tools/call arguments), now: { iso, epochMs } }.
Patterns are tool-name globs (requestSendMoney, notion-update-*), * matching any characters.`

const testSchema = z.object({
  name: z.string().describe('What the case checks'),
  input: z.record(z.string(), z.unknown()).describe('Partial req object; unspecified fields get neutral defaults'),
  expect: z.boolean().describe('true = fine without review (the code must return true); false = must go to review'),
})

const draftShape = {
  effect: z.enum(['allow', 'require']).optional()
    .describe('allow (default): let matching requests that would be reviewed through; require: hold matching requests for review unless the code returns true'),
  description: z.string().describe('One or two sentences: what the rule does, as the user asked for it'),
  patterns: z.array(z.string()).min(1),
  code: z.string().describe('A single JavaScript function expression: (req, h) => boolean'),
  tests: z.array(testSchema).min(2),
  appliesTo: z.enum(['agent', 'all_agents']).optional()
    .describe('agent (default): only your requests; all_agents: every agent using this connection — only when the user asked for it'),
  replacesRuleId: z.string().optional().describe('Set to update an existing rule (creates its next version) instead of adding a new one'),
}

export const createApiRuleTool = tool(
  'create_api_rule',
  `Propose a rule for a connected account (API) that lets matching requests skip the user's review, or requires review for them. The user must approve it before it is saved.

${SEMANTICS}

${API_INPUT}`,
  { accountId: z.string().describe('Connected account id (from your connected accounts)'), ...draftShape },
  async ({ accountId, ...draft }) => jsonResult(await callRulesHost('create', { kind: 'api', targetId: accountId, ...draft })),
)

export const createMcpRuleTool = tool(
  'create_mcp_rule',
  `Propose a rule for a remote MCP server that lets matching tool calls skip the user's review, or requires review for them. The user must approve it before it is saved.

${SEMANTICS}

${MCP_INPUT}`,
  { mcpId: z.string().describe('Remote MCP server id (from REMOTE_MCPS)'), ...draftShape },
  async ({ mcpId, ...draft }) => jsonResult(await callRulesHost('create', { kind: 'mcp', targetId: mcpId, ...draft })),
)

export const listProxyRulesTool = tool(
  'list_proxy_rules',
  'List the rules that apply to your requests on a connected account (kind "api", targetId = account id) or remote MCP server (kind "mcp", targetId = MCP id). Rules you wrote come with their code, patterns, tests and the user-facing description; other rules show only their id, name and effect.',
  { kind: z.enum(['api', 'mcp']), targetId: z.string() },
  async (args) => jsonResult(await callRulesHost('list', args)),
)

export const deleteProxyRuleTool = tool(
  'delete_proxy_rule',
  'Ask the user to delete a rule that applies to your requests. The user must approve; this call blocks until they decide (up to 5 minutes). Never ask to delete a require rule to get a request through.',
  { ruleId: z.string() },
  async (args) => jsonResult(await callRulesHost('delete', args)),
)
