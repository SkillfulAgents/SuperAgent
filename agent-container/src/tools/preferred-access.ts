/**
 * Services reachable both as a connected account (catalog slug in
 * search-connected-account-services) and as a remote MCP (slug in
 * mcp-service-catalog), with the one an agent should reach for by default.
 * `otherWhen` names the tasks that call for the other one.
 */

import { MCP_SERVICES } from './mcp-service-catalog'

export interface PreferredAccess {
  account: string
  mcp: string
  prefer: 'account' | 'mcp'
  otherWhen: string
}

export const PREFERRED_ACCESS: PreferredAccess[] = [
  { account: 'notion', mcp: 'notion', prefer: 'mcp', otherWhen: 'bulk export, webhooks, database queries below the Business plan, unattended runs' },
  { account: 'figma', mcp: 'figma', prefer: 'account', otherWhen: 'never for now, it rejects our client registration' },
  { account: 'linear', mcp: 'linear', prefer: 'mcp', otherWhen: 'webhooks, bulk backfills, custom GraphQL' },
  { account: 'confluence', mcp: 'atlassian', prefer: 'account', otherWhen: 'Rovo semantic search, or Jira in the same task' },
  { account: 'sentry', mcp: 'sentry', prefer: 'mcp', otherWhen: 'releases, alert or admin config, exact queries in scheduled jobs' },
  { account: 'monday', mcp: 'monday', prefer: 'mcp', otherWhen: 'webhooks, large exports' },
  { account: 'airtable', mcp: 'airtable', prefer: 'mcp', otherWhen: 'webhooks, attachment uploads, filterByFormula, large syncs' },
  { account: 'clickup', mcp: 'clickup', prefer: 'mcp', otherWhen: 'more than a few dozen calls a day (the MCP allows 50/day on Free, 300 on Unlimited)' },
  { account: 'intercom', mcp: 'intercom', prefer: 'account', otherWhen: 'read-only research or drafting help articles' },
  { account: 'stripe', mcp: 'stripe', prefer: 'mcp', otherWhen: 'creating PaymentIntents, payouts or transfers, file uploads, bulk work' },
  { account: 'plaid', mcp: 'plaid', prefer: 'account', otherWhen: 'Item debugging or Link analytics' },
  { account: 'dropbox', mcp: 'dropbox', prefer: 'account', otherWhen: 'never for now, it rejects our client registration' },
  { account: 'canva', mcp: 'canva', prefer: 'mcp', otherWhen: 'binary asset uploads, analytics, or outside the desktop app (the MCP only accepts a localhost callback)' },
]

export function accountAccessHint(accountSlug: string): string {
  const p = PREFERRED_ACCESS.find((e) => e.account === accountSlug)
  if (!p) return ''
  const url = MCP_SERVICES.find((s) => s.slug === p.mcp)?.url
  return p.prefer === 'mcp'
    ? ` [MCP ${url} preferred; use this account when: ${p.otherWhen}]`
    : ` [preferred over MCP ${url}; use the MCP when: ${p.otherWhen}]`
}

export function mcpAccessHint(mcpSlug: string): string {
  const p = PREFERRED_ACCESS.find((e) => e.mcp === mcpSlug)
  if (!p) return ''
  return p.prefer === 'account'
    ? ` [connected account "${p.account}" preferred; use this MCP when: ${p.otherWhen}]`
    : ` [preferred over connected account "${p.account}"; use the account when: ${p.otherWhen}]`
}
