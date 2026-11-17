import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { AGENT_DESKTOP_TOOLS } from './agent-desktop-tools'
import {
  COMPUTER_USE_GUIDANCE_HINT,
  COMPUTER_USE_SERVER,
  COMPUTER_USE_TOOL_PREFIX,
  agentDesktopTool,
  computerUseTools,
  toolInputSchema,
} from './computer-use'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockComputerUseOutput(output: string) {
  vi.spyOn(inputManager, 'consumeCurrentToolUseId').mockReturnValue('tool-use-1')
  return vi.spyOn(inputManager, 'createPendingWithType').mockResolvedValue(output)
}

const toolNamed = (name: string) => (computerUseTools as any[]).find((t) => t.name === name)

describe('computer-use tools', () => {
  // Claude Code reserves `computer-use` for Anthropic's own computer use and
  // adds that tool's instructions to the prompt of any session with a server
  // by that name.
  it('are served as agent-desktop, not under the name Claude Code reserves', () => {
    expect(COMPUTER_USE_SERVER).toBe('agent-desktop')
    expect(COMPUTER_USE_TOOL_PREFIX).toBe('mcp__agent-desktop__')
  })

  it('has one tool per generated command, and agent_desktop for any command', () => {
    expect((computerUseTools as any[]).map((t) => t.name)).toEqual([...AGENT_DESKTOP_TOOLS.map((spec) => spec.tool), 'agent_desktop'])
  })

  it('takes exactly the command\'s arguments and flags as params', () => {
    for (const spec of AGENT_DESKTOP_TOOLS) {
      const expected = [...spec.arguments.map((arg) => arg.name), ...spec.options.map((option) => option.name)].sort()
      expect(Object.keys(toolNamed(spec.tool).inputSchema).sort(), spec.tool).toEqual(expected)
    }
  })

  it('types each param as agent-desktop takes it', () => {
    const click = z.object(toolInputSchema(AGENT_DESKTOP_TOOLS.find((spec) => spec.command === 'click')!))
    expect(click.safeParse({ ref: '@s1:e1', headed: true, timeout_ms: 9000 }).success).toBe(true)
    expect(click.safeParse({ headed: true }).success).toBe(false)
    const snapshot = z.object(toolInputSchema(AGENT_DESKTOP_TOOLS.find((spec) => spec.command === 'snapshot')!))
    expect(snapshot.safeParse({ surface: 'menu' }).success).toBe(true)
    expect(snapshot.safeParse({ surface: 'not-a-surface' }).success).toBe(false)
  })

  it('takes one value or several for a repeatable flag', () => {
    const find = z.object(toolInputSchema(AGENT_DESKTOP_TOOLS.find((spec) => spec.command === 'find')!))
    expect(find.safeParse({ state: 'focused' }).success).toBe(true)
    expect(find.safeParse({ state: ['focused', 'enabled=true'] }).success).toBe(true)
  })

  it("offers the surfaces the host's OS has, as agent-desktop's status there names them", () => {
    const spec = AGENT_DESKTOP_TOOLS.find((s) => s.command === 'snapshot')!
    const onMac = z.object(toolInputSchema(spec, 'macos'))
    expect(onMac.safeParse({ surface: 'menu-bar-extras' }).success).toBe(true)
    expect(onMac.safeParse({ surface: 'toolbar' }).success).toBe(false)
    // An OS the generator could not ask keeps every surface the help lists.
    expect(z.object(toolInputSchema(spec, 'windows')).safeParse({ surface: 'toolbar' }).success).toBe(true)
  })

  it('sends each tool\'s command with the params as given, for the host to turn into the command line', async () => {
    const pending = mockComputerUseOutput('{"ok":true}')

    await toolNamed('computer_set_value').handler({ ref: '@s1:e1', value: 'hi' })
    expect(pending).toHaveBeenCalledWith('tool-use-1', 'computer_use', { method: 'set-value', params: { ref: '@s1:e1', value: 'hi' } })

    await (agentDesktopTool as any).handler({ args: ['double-click', '@s1:e3'] })
    expect(pending).toHaveBeenLastCalledWith('tool-use-1', 'computer_use', { method: 'run', params: { args: ['double-click', '@s1:e3'] } })
  })

  it('returns agent-desktop\'s output as text', async () => {
    mockComputerUseOutput('Usage: agent-desktop mouse-click [OPTIONS] --xy <XY>')

    const result = await (agentDesktopTool as any).handler({ args: ['mouse-click', '--help'] })

    expect(result.content).toEqual([{ type: 'text', text: 'Usage: agent-desktop mouse-click [OPTIONS] --xy <XY>' }])
  })

  it('returns a screenshot as the image and its line on where it is', async () => {
    mockComputerUseOutput(JSON.stringify({ type: 'screenshot', base64: 'aGVsbG8=', media_type: 'image/png', width: 10, height: 10, note: 'This image is 10×10 pixels.' }))

    const result = await toolNamed('computer_screenshot').handler({ app: 'Safari' })

    expect(result.content).toEqual([
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'text', text: 'This image is 10×10 pixels.' },
    ])
  })

  it('adds the guide hint to launch only, where a parent starts', async () => {
    mockComputerUseOutput('{"ok":true}')

    expect((await toolNamed('computer_launch').handler({ app: 'TextEdit' })).content[0].text).toContain(COMPUTER_USE_GUIDANCE_HINT)
    expect((await toolNamed('computer_snapshot').handler({})).content[0].text).not.toContain(COMPUTER_USE_GUIDANCE_HINT)
  })
})
