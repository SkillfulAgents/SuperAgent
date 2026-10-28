import { describe, it, expect } from 'vitest'
import { unwrapComputerRun, resolveComputerUseMethodName, COMPUTER_RUN_METHOD } from './computer-run'
import { getRequiredPermissionLevel } from './types'

describe('resolveComputerUseMethodName', () => {
  it('maps the menu tool to the SDK menuClick wrapper and leaves others alone', () => {
    expect(resolveComputerUseMethodName('menu')).toBe('menuClick')
    expect(resolveComputerUseMethodName('click')).toBe('click')
    expect(resolveComputerUseMethodName('clipboard_read')).toBe('clipboard_read')
  })
})

describe('unwrapComputerRun', () => {
  it('arrives as the run method', () => {
    expect(COMPUTER_RUN_METHOD).toBe('run')
  })

  it('passes ordinary methods through untouched', () => {
    const params = { ref: '@b1' }
    expect(unwrapComputerRun('click', params)).toEqual({ method: 'click', params })
  })

  it('unwraps computer_run into the inner command and args', () => {
    expect(unwrapComputerRun('run', { command: 'clipboard_read', args: {} }))
      .toEqual({ method: 'clipboard_read', params: {} })
    expect(unwrapComputerRun('run', { command: 'drag', args: { from: '@b1', to: '@b2' } }))
      .toEqual({ method: 'drag', params: { from: '@b1', to: '@b2' } })
  })

  it('defaults missing or malformed args to an empty object', () => {
    expect(unwrapComputerRun('run', { command: 'clipboard_read' }).params).toEqual({})
    expect(unwrapComputerRun('run', { command: 'clipboard_read', args: ['x'] }).params).toEqual({})
    expect(unwrapComputerRun('run', { command: 'clipboard_read', args: 'x' }).params).toEqual({})
  })

  it('applies the tool-name aliases so run("menu") reaches the SDK wrapper', () => {
    expect(unwrapComputerRun('run', { command: 'menu', args: { path: 'File > Save' } }).method).toBe('menuClick')
  })

  it('trims the command', () => {
    expect(unwrapComputerRun('run', { command: '  windows ' }).method).toBe('windows')
  })

  it('leaves a run without a usable command alone so the executor can reject it', () => {
    expect(unwrapComputerRun('run', {})).toEqual({ method: 'run', params: {} })
    expect(unwrapComputerRun('run', { command: '' })).toEqual({ method: 'run', params: { command: '' } })
    expect(unwrapComputerRun('run', { command: 42 })).toEqual({ method: 'run', params: { command: 42 } })
  })

  it('makes the unwrapped method drive the permission level', () => {
    expect(getRequiredPermissionLevel(unwrapComputerRun('run', { command: 'windows' }).method)).toBe('list_apps_windows')
    expect(getRequiredPermissionLevel(unwrapComputerRun('run', { command: 'clipboard_set' }).method)).toBe('use_application')
  })
})
