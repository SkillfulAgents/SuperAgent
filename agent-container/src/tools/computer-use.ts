/**
 * Computer Use Tools
 *
 * MCP tools that run agent-desktop commands on the host computer. Each
 * `computer_<command>` tool is generated from that command's `--help`
 * (./agent-desktop-tools.ts): its params are the command's arguments and
 * flags, with agent-desktop's own descriptions. `agent_desktop({ args })` runs
 * any command as its argument list. The host turns either into the command
 * line, adds the session, and runs it as given; the result is what
 * agent-desktop printed.
 *
 * Each tool call blocks via InputManager until the host approves and runs it.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { computerUseHostOs } from '../host-desktop-env'
import { inputManager } from '../input-manager'
import { AGENT_DESKTOP_TOOLS, type AgentDesktopToolSpec } from './agent-desktop-tools'

// Conditional to match the prompt, which tells a parent with a computer-use
// subagent to delegate rather than read. See BROWSER_USE_GUIDANCE_HINT.
export const COMPUTER_USE_GUIDANCE_HINT =
  'Guidance: if you will drive the app yourself rather than delegate to the computer-use agent, read `/opt/gamut/docs/computer-use.md` before interacting (unless you already read it in this conversation).'

/**
 * The hint rides on `launch` alone: the parent launches before it drives or
 * delegates, and the computer-use agent, which has the guide in its prompt
 * already, has no launch tool (its prompt leaves launching to the parent).
 */
const COMPUTER_USE_GUIDANCE_METHODS = new Set(['launch'])

/**
 * Shared helper: creates a pending input request that blocks until the host
 * resolves (executes) or rejects (denies) the computer use command.
 */
async function computerUseRequest(method: string, params: Record<string, unknown>) {
  const toolUseId = inputManager.consumeCurrentToolUseId()

  if (!toolUseId) {
    console.error(`[computer_use:${method}] No toolUseId available`)
    return {
      content: [{ type: 'text' as const, text: 'Unable to process computer use request - no tool use ID available.' }],
      isError: true,
    }
  }

  try {
    const output = await inputManager.createPendingWithType<string>(toolUseId, 'computer_use', { method, params })

    // A screenshot comes back from the host as the image and one line on
    // where it is on screen.
    if (output?.startsWith('{"type":"screenshot"')) {
      try {
        const parsed = JSON.parse(output)
        if (parsed.type === 'screenshot' && typeof parsed.base64 === 'string') {
          const content: Array<{ type: 'image'; data: string; mimeType: `image/${string}` } | { type: 'text'; text: string }> = [
            { type: 'image' as const, data: parsed.base64, mimeType: (parsed.media_type || 'image/png') as `image/${string}` },
          ]
          if (typeof parsed.note === 'string') content.push({ type: 'text' as const, text: parsed.note })
          return { content }
        }
      } catch {
        // Fall through to text response
      }
    }

    const text = output || `${method} completed.`
    const guidance = COMPUTER_USE_GUIDANCE_METHODS.has(method)
      ? `\n\n${COMPUTER_USE_GUIDANCE_HINT}`
      : ''
    return {
      content: [{ type: 'text' as const, text: `${text}${guidance}` }],
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.log(`[computer_use:${method}] Request failed: ${errorMessage}`)

    return {
      content: [{ type: 'text' as const, text: `Computer use request failed: ${errorMessage}` }],
      isError: true,
    }
  }
}

/** A value a flag or argument takes: text, or a number for the numeric ones. */
const VALUE = z.union([z.string(), z.number()])

/** A repeatable flag's values: one, or several. */
const VALUES = z.union([z.string(), z.array(z.string())])

/**
 * A tool's input schema: one param per argument and flag, described as
 * agent-desktop describes it. A flag's choices are the ones the host's OS
 * takes (`platform`, as agent-desktop's `status` names it) when known.
 */
export function toolInputSchema(spec: AgentDesktopToolSpec, platform?: string): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {}
  for (const arg of spec.arguments) {
    const schema = VALUE.describe(arg.description || arg.name)
    shape[arg.name] = arg.required ? schema : schema.optional()
  }
  for (const option of spec.options) {
    const values = (platform && option.platformValues?.[platform]) || option.values
    const base = option.kind === 'switch'
      ? z.boolean()
      : option.kind === 'list'
        ? VALUES
        : values?.length
          ? z.enum(values as [string, ...string[]])
          : VALUE
    const schema = base.describe(`${option.flag}: ${option.description}`)
    shape[option.name] = option.required ? schema : schema.optional()
  }
  return shape
}

/**
 * The MCP server the computer-use tools are served from, so their names are
 * `mcp__agent-desktop__<tool>`. Not `computer-use`: Claude Code reserves that
 * name for Anthropic's own computer use and adds that tool's instructions to
 * every session that has a server by that name.
 */
export const COMPUTER_USE_SERVER = 'agent-desktop'
export const COMPUTER_USE_TOOL_PREFIX = `mcp__${COMPUTER_USE_SERVER}__`

/**
 * The `computer_<command>` tools, one per command in the generated specs. All
 * of them wait behind tool search (computer use is rare, and they would cost
 * every session's prompt), unless the session was started for computer use
 * (`preloadToolsets`).
 */
export const computerCommandTools = AGENT_DESKTOP_TOOLS.map((spec) => tool(
  spec.tool,
  `${spec.description} Runs \`agent-desktop ${spec.command}\`.`,
  toolInputSchema(spec, computerUseHostOs()?.platform),
  async (args) => computerUseRequest(spec.command, args),
))

export const agentDesktopTool = tool(
  'agent_desktop',
  `Run any agent-desktop command, given as its arguments without the "agent-desktop" prefix, the command first, e.g. ["drag", "--from", "@s8f3k2p9:e1", "--to", "@s8f3k2p9:e5", "--headed"] or ["click", "--help"]. Every command and flag in the guide works here, except what the app sets or refuses. It runs agent-desktop only; it is not a shell, so pass each argument as its own string.`,
  {
    args: z.array(z.string()).min(1).describe('The command and its arguments, e.g. ["double-click", "@s8f3k2p9:e3"]'),
  },
  async (toolArgs) => computerUseRequest('run', { args: toolArgs.args }),
)

export const computerUseTools = [...computerCommandTools, agentDesktopTool]
