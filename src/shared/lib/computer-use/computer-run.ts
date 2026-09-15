/**
 * The container's `computer_run` escape-hatch tool.
 *
 * Kept in its own module (no imports from ./types) because several test
 * suites replace '@shared/lib/computer-use/types' with a hand-written mock
 * that only knows the exports they list.
 */

/** Method name the container's `computer_run` tool arrives as on the host. */
export const COMPUTER_RUN_METHOD = 'run'

/**
 * Tool-name suffixes that do not match the SDK/daemon method they invoke.
 * Everything else maps to itself.
 */
const METHOD_ALIASES: Record<string, string> = {
  menu: 'menuClick',
}

/** Resolve a `computer_<suffix>` tool suffix (or a raw command) to the method the executor dispatches. */
export function resolveComputerUseMethodName(name: string): string {
  return METHOD_ALIASES[name] ?? name
}

/**
 * `computer_run` wraps another daemon method: its input is
 * `{ command: "<method>", args: { ...params } }`. Unwrap it so permission
 * checks, the approval card and the executor all see the real method.
 * Anything else passes through untouched. A `run` without a usable
 * `command` is left as-is so the executor rejects it with a clear error.
 */
export function unwrapComputerRun(
  method: string,
  params: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } {
  if (method !== COMPUTER_RUN_METHOD) return { method, params }
  const command = params.command
  if (typeof command !== 'string' || !command.trim()) return { method, params }
  const inner = command.trim()
  const args = params.args
  const innerParams = args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
  return { method: resolveComputerUseMethodName(inner), params: innerParams }
}
