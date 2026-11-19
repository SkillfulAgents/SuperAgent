/**
 * A computer-use tool call as the agent-desktop command line it stands for.
 *
 * Agents call `computer_<command>` tools, generated from each command's
 * `--help` (agent-desktop-tools.ts), or `agent_desktop({ args })` with any
 * command's arguments. Permission checks, the approval card and the executor
 * all take the same shape: the command, and its arguments as `{ argv }`.
 *
 * Kept apart from ./types (and free of its imports) because several test
 * suites replace '@shared/lib/computer-use/types' with a hand-written mock
 * that only knows the exports they list.
 */

import { AGENT_DESKTOP_TOOLS, type AgentDesktopToolSpec } from './agent-desktop-tools'

/** The method the `agent_desktop` tool arrives as, before its arguments are read. */
export const COMPUTER_RUN_METHOD = 'run'

/** The catch-all tool: any agent-desktop command, as its argument list. */
export const AGENT_DESKTOP_TOOL = 'agent_desktop'

/**
 * The tool-name prefixes of computer-use calls: the container's MCP server
 * `agent-desktop`, and `computer-use`, its name in older sessions (renamed
 * because Claude Code reserves it for Anthropic's own computer use and
 * gives every session that tool's instructions).
 */
const TOOL_PREFIXES = ['mcp__agent-desktop__', 'mcp__computer-use__'] as const

/** Whether a tool call is a computer-use command. */
export function isComputerUseToolName(toolName: string): boolean {
  return TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
}

/**
 * The method a computer-use tool sends: `computer_set_value` sends
 * `set-value`, and `agent_desktop` sends `run`, read as the command its
 * arguments name.
 */
export function computerUseMethodFromToolName(toolName: string): string {
  const prefix = TOOL_PREFIXES.find((candidate) => toolName.startsWith(candidate))
  const name = prefix ? toolName.slice(prefix.length) : toolName
  if (name === AGENT_DESKTOP_TOOL) return COMPUTER_RUN_METHOD
  return name.replace(/^computer_/, '').replace(/_/g, '-')
}

const SPECS: ReadonlyMap<string, AgentDesktopToolSpec> = new Map(AGENT_DESKTOP_TOOLS.map((spec) => [spec.command, spec]))

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false
}

/**
 * A generated tool's params as its command's arguments: each flag as
 * `--flag=value` (a switch bare, a list once per value), then `--` and the
 * positionals in the command's order, so a value that starts with `-` stays a
 * value. Params the command does not have are left out, as the tool's own
 * schema leaves them out.
 */
export function toolArgv(spec: AgentDesktopToolSpec, params: Record<string, unknown>): string[] {
  const flags: string[] = []
  for (const option of spec.options) {
    const value = params[option.name]
    if (!present(value)) continue
    if (option.kind === 'switch') {
      if (value === true) flags.push(option.flag)
      continue
    }
    const values = option.kind === 'list' && Array.isArray(value) ? value : [value]
    for (const item of values) flags.push(`${option.flag}=${String(item)}`)
  }
  // A required argument given as '' is still given (`set-value <ref> ""` clears a field).
  const given = (arg: AgentDesktopToolSpec['arguments'][number]) => {
    const value = params[arg.name]
    return arg.required ? value !== undefined && value !== null : present(value)
  }
  const positionals = spec.arguments.flatMap((arg) => (given(arg) ? [String(params[arg.name])] : []))
  return positionals.length > 0 ? [...flags, '--', ...positionals] : flags
}

/** Global switches agent-desktop's guides write before the command (`agent-desktop --headed drag …`). */
const LEADING_SWITCHES: ReadonlySet<string> = new Set(['--headed'])

/** Global flags with a value that may come before the command too. */
const LEADING_VALUE_FLAGS: ReadonlySet<string> = new Set(['-w', '--wait-for', '--wait-for-gone', '--wait-timeout'])

/**
 * A computer-use call as a command line: `{ method: <command>, params: { argv } }`.
 * `agent_desktop({ args })` is its own first argument, after any global flags
 * written before it (`["--headed", "drag", …]`), which go after it; a
 * generated tool's params become its command's arguments. A call already in
 * that shape, or one this cannot read (a `run` with no command), passes
 * through for the executor to refuse with a clear error.
 */
export function commandLineOf(
  method: string,
  params: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } {
  if (method === COMPUTER_RUN_METHOD) {
    const args = params.args
    if (!Array.isArray(args) || args.length === 0 || args.some((token) => typeof token !== 'string')) {
      return { method, params }
    }
    const tokens = args as string[]
    const leading: string[] = []
    let i = 0
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const token = tokens[i]
      const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
      if (LEADING_SWITCHES.has(token)) {
        leading.push(token)
        i += 1
      } else if (LEADING_VALUE_FLAGS.has(name) && (token.includes('=') || i + 1 < tokens.length)) {
        leading.push(...(token.includes('=') ? [token] : [token, tokens[i + 1]]))
        i += token.includes('=') ? 1 : 2
      } else {
        break
      }
    }
    const command = tokens[i]
    if (command === undefined || !command.trim() || command.startsWith('-')) return { method, params }
    return { method: command.trim(), params: { argv: [...leading, ...tokens.slice(i + 1)] } }
  }
  if (Array.isArray(params.argv)) return { method, params }
  const spec = SPECS.get(method)
  return spec ? { method, params: { argv: toolArgv(spec, params) } } : { method, params }
}
