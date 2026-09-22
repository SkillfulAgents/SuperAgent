/**
 * Reserved MCP server names that collide with built-in MCP servers.
 */
export const RESERVED_MCP_NAMES = new Set(['user_input', 'browser', 'dashboards']);

/**
 * Sanitize an MCP server name for use as an SDK MCP server key.
 * Lowercases, replaces non-alphanumeric chars with underscores,
 * User names cannot occupy built-in or integration-owned namespaces.
 */
export function sanitizeMcpName(name: string, agentOwned = false): string {
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (RESERVED_MCP_NAMES.has(sanitized) || (!agentOwned && sanitized.startsWith('agent_integration_'))) {
    sanitized = `remote_${sanitized}`;
  }
  return sanitized;
}
