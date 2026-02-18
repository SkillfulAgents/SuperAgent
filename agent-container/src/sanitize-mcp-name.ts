/**
 * Reserved MCP server names that collide with built-in MCP servers.
 */
export const RESERVED_MCP_NAMES = new Set(['user_input', 'browser', 'dashboards']);

/**
 * Sanitize an MCP server name for use as an SDK MCP server key.
 * Lowercases, replaces non-alphanumeric chars with underscores,
 * and prefixes with "remote_" if the result collides with a built-in name.
 */
export function sanitizeMcpName(name: string): string {
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (RESERVED_MCP_NAMES.has(sanitized)) {
    sanitized = `remote_${sanitized}`;
  }
  return sanitized;
}
