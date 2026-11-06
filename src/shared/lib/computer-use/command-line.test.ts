import { describe, expect, it } from 'vitest'
import { AGENT_DESKTOP_TOOLS } from './agent-desktop-tools'
import { commandLineOf, computerUseMethodFromToolName, toolArgv } from './command-line'

const spec = (command: string) => {
  const found = AGENT_DESKTOP_TOOLS.find((s) => s.command === command)
  if (!found) throw new Error(`no tool for ${command}`)
  return found
}

describe('computerUseMethodFromToolName', () => {
  it('sends the command a tool is named after, and run for agent_desktop', () => {
    expect(computerUseMethodFromToolName('mcp__computer-use__computer_snapshot')).toBe('snapshot')
    expect(computerUseMethodFromToolName('mcp__computer-use__computer_set_value')).toBe('set-value')
    expect(computerUseMethodFromToolName('mcp__computer-use__computer_mouse_click')).toBe('mouse-click')
    expect(computerUseMethodFromToolName('mcp__computer-use__agent_desktop')).toBe('run')
  })
})

describe('toolArgv', () => {
  it('writes flags as --flag=value, switches bare, then the positionals after --', () => {
    expect(toolArgv(spec('snapshot'), { app: 'Spotify', skeleton: true, max_depth: 4, compact: false }))
      .toEqual(['--app=Spotify', '--max-depth=4', '--skeleton'])
    expect(toolArgv(spec('type'), { ref: '@s1:e2', text: '-5', interval_ms: 40 }))
      .toEqual(['--interval-ms=40', '--', '@s1:e2', '-5'])
    expect(toolArgv(spec('press'), { combo: 'cmd+k', app: 'Spotify', headed: true }))
      .toEqual(['--app=Spotify', '--headed', '--', 'cmd+k'])
    expect(toolArgv(spec('mouse-click'), { xy: '980,977', button: 'right', headed: true }))
      .toEqual(['--xy=980,977', '--button=right', '--headed'])
  })

  it('repeats a list flag once per value', () => {
    expect(toolArgv(spec('find'), { role: 'button', state: ['focused', 'enabled=false'] }))
      .toEqual(['--role=button', '--state=focused', '--state=enabled=false'])
  })

  it('leaves out params the command does not have', () => {
    expect(toolArgv(spec('click'), { ref: '@s1:e1', x: 3, y: 4 })).toEqual(['--', '@s1:e1'])
  })
})

describe('commandLineOf', () => {
  it('reads agent_desktop\'s first argument as its command', () => {
    expect(commandLineOf('run', { args: ['drag', '--from', '@s1:e1', '--to', '@s1:e2'] }))
      .toEqual({ method: 'drag', params: { argv: ['--from', '@s1:e1', '--to', '@s1:e2'] } })
    expect(commandLineOf('run', { args: ['  list-windows '] }).method).toBe('list-windows')
  })

  it('turns a generated tool\'s params into its command line', () => {
    expect(commandLineOf('click', { ref: '@s1:e5', wait_for: 'sheet:' }))
      .toEqual({ method: 'click', params: { argv: ['--wait-for=sheet:', '--', '@s1:e5'] } })
    expect(commandLineOf('list-apps', {})).toEqual({ method: 'list-apps', params: { argv: [] } })
  })

  it('passes through a command line, and what it cannot read', () => {
    expect(commandLineOf('click', { argv: ['@s1:e1'] })).toEqual({ method: 'click', params: { argv: ['@s1:e1'] } })
    expect(commandLineOf('run', {})).toEqual({ method: 'run', params: {} })
    expect(commandLineOf('run', { args: [] })).toEqual({ method: 'run', params: { args: [] } })
    expect(commandLineOf('run', { args: [42] })).toEqual({ method: 'run', params: { args: [42] } })
    expect(commandLineOf('run', { args: ['--verbose', 'click'] }).method).toBe('run')
    expect(commandLineOf('run', { args: ['--headed'] }).method).toBe('run')
    expect(commandLineOf('mouse-wheel', { x: 1 })).toEqual({ method: 'mouse-wheel', params: { x: 1 } })
  })

  it('reads global flags written before the command, as the guides write them, after it', () => {
    expect(commandLineOf('run', { args: ['--headed', 'drag', '--from', '@s1:e1', '--to', '@s1:e2'] }))
      .toEqual({ method: 'drag', params: { argv: ['--headed', '--from', '@s1:e1', '--to', '@s1:e2'] } })
    expect(commandLineOf('run', { args: ['-w', 'sheet:', '--headed', 'click', '@s1:e5'] }))
      .toEqual({ method: 'click', params: { argv: ['-w', 'sheet:', '--headed', '@s1:e5'] } })
    expect(commandLineOf('run', { args: ['--wait-timeout=5000', 'press', '--', 'return'] }))
      .toEqual({ method: 'press', params: { argv: ['--wait-timeout=5000', '--', 'return'] } })
  })
})
