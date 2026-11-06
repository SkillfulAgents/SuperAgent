import { describe, expect, it } from 'vitest'
import {
  buildCommandArgs,
  callTargets,
  ComputerUseArgumentError,
  isSystemTarget,
  permissionLevelOf,
  requestsHeaded,
  snapshotIdOfRef,
  SYSTEM_TARGETS,
} from './commands'

describe('buildCommandArgs', () => {
  it('passes a command line through as given', () => {
    expect(buildCommandArgs('double-click', { argv: ['@s1:e3'] })).toEqual(['double-click', '@s1:e3'])
    expect(buildCommandArgs('wait', { argv: ['--event', 'window-opened', '--app', 'TextEdit'] }))
      .toEqual(['wait', '--event', 'window-opened', '--app', 'TextEdit'])
    expect(buildCommandArgs('click', { argv: ['--headed', '--', '@s1:e1'] })).toEqual(['click', '--headed', '--', '@s1:e1'])
    expect(buildCommandArgs('skills', { argv: ['get', 'desktop'] })).toEqual(['skills', 'get', 'desktop'])
    expect(buildCommandArgs('click', { argv: ['--help'] })).toEqual(['click', '--help'])
  })

  it.each([
    ['--session'], ['--session=abc'], ['--agent-id'], ['--trace'], ['--trace-strict'], ['--screenshot'], ['--debug'],
  ])('refuses the global flag the app owns: %s', (flag) => {
    expect(() => buildCommandArgs('click', { argv: [flag, '@s1:e1'] })).toThrow(/set by the app/)
  })

  it.each(['session', 'trace', 'cursor-overlay'])('refuses the %s command', (command) => {
    expect(() => buildCommandArgs(command, { argv: [] })).toThrow(/not available to agents/)
  })

  it('refuses launch flags that would run arbitrary code or open a debugging port', () => {
    for (const flag of ['--cdp', '--arg=--foo', '--env', '--cwd']) {
      expect(() => buildCommandArgs('launch', { argv: [flag, '--', 'Slack'] })).toThrow(/not available to agents/)
    }
  })

  it('refuses forced shortcuts and permission prompts', () => {
    expect(() => buildCommandArgs('press', { argv: ['--app', 'Finder', '--force', '--', 'cmd+q'] })).toThrow(/--force/)
    expect(() => buildCommandArgs('permissions', { argv: ['--request'] })).toThrow(/--request/)
    expect(buildCommandArgs('permissions', { argv: [] })).toEqual(['permissions'])
  })

  it('reads nothing after -- as a flag', () => {
    expect(buildCommandArgs('type', { argv: ['--', '@s1:e2', '--session x'] })).toEqual(['type', '--', '@s1:e2', '--session x'])
    expect(buildCommandArgs('press', { argv: ['--app=Notes', '--', '--force'] })).toEqual(['press', '--app=Notes', '--', '--force'])
  })

  it('refuses a screenshot path, but not a flag value', () => {
    expect(() => buildCommandArgs('screenshot', { argv: ['--app', 'Finder', '/tmp/x.png'] })).toThrow(/no output path/)
    expect(() => buildCommandArgs('screenshot', { argv: ['--app=Finder', '--', '/tmp/x.png'] })).toThrow(/no output path/)
    expect(buildCommandArgs('screenshot', { argv: ['--app', 'Finder'] })).toEqual(['screenshot', '--app', 'Finder'])
    expect(buildCommandArgs('screenshot', { argv: ['--screen', '0'] })).toEqual(['screenshot', '--screen', '0'])
  })

  it('refuses clipboard paths on the host', () => {
    expect(() => buildCommandArgs('clipboard-get', { argv: ['--format', 'image', '--out', '/tmp/x.png'] })).toThrow(/not available/)
    expect(() => buildCommandArgs('clipboard-set', { argv: ['--image=/etc/x.png'] })).toThrow(/not available/)
    expect(buildCommandArgs('clipboard-set', { argv: ['hello'] })).toEqual(['clipboard-set', 'hello'])
  })

  it('checks every batch entry', () => {
    const ok = JSON.stringify([{ command: 'click', args: { ref_id: '@s1:e1' } }, { command: 'wait', args: { ms: 200 } }])
    expect(buildCommandArgs('batch', { argv: [ok, '--stop-on-error'] })).toEqual(['batch', ok, '--stop-on-error'])
    expect(() => buildCommandArgs('batch', { argv: [JSON.stringify([{ command: 'session', args: {} }])] })).toThrow(/managed by the app/)
    expect(() => buildCommandArgs('batch', { argv: [JSON.stringify([{ command: 'click', session: 'other', args: {} }])] })).toThrow(/session/)
    expect(() => buildCommandArgs('batch', { argv: [JSON.stringify([{ command: 'press', args: { combo: 'cmd+q', force: true } }])] })).toThrow(/force/)
    expect(() => buildCommandArgs('batch', { argv: [JSON.stringify([{ command: 'clipboard-set', args: { file_url: '/x' } }])] })).toThrow(/not available/)
    expect(() => buildCommandArgs('batch', { argv: ['not json'] })).toThrow(ComputerUseArgumentError)
  })

  it('asks for a command when agent_desktop names none, and for strings', () => {
    expect(() => buildCommandArgs('run', { args: [] })).toThrow(/needs the command first/)
    expect(() => buildCommandArgs('click', { argv: [1] })).toThrow(/list of strings/)
  })

  it('checks the batch agent-desktop runs: its one JSON array, not a decoy in a flag\'s value', () => {
    const decoy = ['--wait-for', '[]', JSON.stringify([{ command: 'session', args: {} }])]
    expect(() => buildCommandArgs('batch', { argv: decoy })).toThrow(/one JSON array/)
    const entries = JSON.stringify([{ command: 'session', args: {} }])
    expect(() => buildCommandArgs('batch', { argv: ['--timeout-ms', '5000', entries] })).toThrow(/managed by the app/)
    expect(() => buildCommandArgs('batch', { argv: ['--', entries] })).toThrow(/managed by the app/)
    expect(() => buildCommandArgs('batch', { argv: ['--stop-on-error'] })).toThrow(/needs its JSON array/)
  })
})

describe('requestsHeaded', () => {
  it('reads --headed among the flags, not in a typed value', () => {
    expect(requestsHeaded(['double-click', '--headed', '--', '@s1:e1'])).toBe(true)
    expect(requestsHeaded(['click', '--', '@s1:e1'])).toBe(false)
    expect(requestsHeaded(['type', '--', '@s1:e1', '--headed'])).toBe(false)
  })
})

describe('callTargets', () => {
  it('reads the app, windows and snapshots a command line names, in either flag form', () => {
    expect(callTargets('snapshot', { argv: ['--app=Finder', '--window-id', 'w-1'] })).toEqual({ app: 'Finder', windowIds: ['w-1'], snapshotIds: [] })
    expect(callTargets('click', { argv: ['--', '@s8f3k2p9:e5'] })).toEqual({ windowIds: [], snapshotIds: ['s8f3k2p9'] })
    expect(callTargets('wait', { argv: ['--app', 'TextEdit'] }).app).toBe('TextEdit')
    expect(callTargets('drag', { argv: ['--from', '@a:e1', '--to', '@b:e2'] }).snapshotIds).toEqual(['a', 'b'])
  })

  it('reads a ref given as a flag\'s value, as the generated tools write it', () => {
    expect(callTargets('snapshot', { argv: ['--root=@s7:e3'] }).snapshotIds).toEqual(['s7'])
    expect(callTargets('drag', { argv: ['--from=@a:e1', '--to=@b:e2'] }).snapshotIds).toEqual(['a', 'b'])
  })

  it('has nothing to read in batch --help', () => {
    expect(callTargets('batch', { argv: ['--help'] })).toEqual({ windowIds: [], snapshotIds: [] })
  })

  it('reads launch\'s app from its positional', () => {
    expect(callTargets('launch', { argv: ['Calculator'] }).app).toBe('Calculator')
    expect(callTargets('launch', { argv: ['--activate', '--', 'Calculator'] }).app).toBe('Calculator')
  })

  it('takes no flag from text after --', () => {
    expect(callTargets('type', { argv: ['--', '@s1:e1', '--app=Mail'] })).toEqual({ windowIds: [], snapshotIds: ['s1'] })
  })

  it('reads every batch entry', () => {
    const entries = JSON.stringify([{ command: 'click', args: { ref_id: '@a:e1' } }, { command: 'press', args: { combo: 'x', app: 'Notes' } }])
    expect(callTargets('batch', { argv: [entries] })).toEqual({ app: 'Notes', windowIds: [], snapshotIds: ['a'] })
  })

  it('reads the screen points a pointer command acts at', () => {
    expect(callTargets('mouse-click', { argv: ['--xy=100,-20', '--button', 'right'] }).points).toEqual([{ x: 100, y: -20 }])
    expect(callTargets('drag', { argv: ['--from-xy', '1,2', '--to-xy=3,4'] }).points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }])
    expect(callTargets('batch', { argv: [JSON.stringify([{ command: 'mouse-click', args: { xy: '5,6' } }])] }).points).toEqual([{ x: 5, y: 6 }])
  })

  it('names the clipboard, the whole screen and notifications as their own targets', () => {
    expect(callTargets('clipboard-get', { argv: [] }).system).toBe(SYSTEM_TARGETS.clipboard)
    expect(callTargets('screenshot', { argv: ['--screen', '1'] }).system).toBe(SYSTEM_TARGETS.screen)
    expect(callTargets('screenshot', { argv: ['--app=Safari'] }).system).toBeUndefined()
    expect(callTargets('dismiss-all-notifications', { argv: [] }).system).toBe(SYSTEM_TARGETS.notifications)
    expect(callTargets('wait', { argv: ['--notification'] }).system).toBe(SYSTEM_TARGETS.notifications)
    expect(isSystemTarget('Clipboard')).toBe(true)
    expect(isSystemTarget('Safari')).toBe(false)
  })

  it('refuses a batch that acts on two of them', () => {
    const batch = JSON.stringify([{ command: 'clipboard-get', args: {} }, { command: 'list-notifications', args: {} }])
    expect(() => callTargets('batch', { argv: [batch] })).toThrow(/one target/)
  })

  const batch = (...entries: Array<{ command: string; args?: Record<string, unknown> }>) => ({ argv: [JSON.stringify(entries)] })

  it('refuses a batch whose entries act in two apps, or in an app and on another target', () => {
    expect(() => callTargets('batch', batch(
      { command: 'list-windows', args: { app: 'Notes' } },
      { command: 'snapshot', args: { app: '1Password' } },
    ))).toThrow(/names Notes, 1Password\. Send one call/)
    expect(() => callTargets('batch', batch(
      { command: 'clipboard-get', args: {} },
      { command: 'snapshot', args: { app: 'Safari' } },
    ))).toThrow(/Clipboard, Safari/)
    // A screenshot entry that names no app or window captures the whole screen.
    expect(() => callTargets('batch', batch(
      { command: 'snapshot', args: { app: 'Safari' } },
      { command: 'screenshot', args: {} },
    ))).toThrow(/Safari, Entire screen/)
    expect(callTargets('batch', batch({ command: 'screenshot', args: {} })).system).toBe(SYSTEM_TARGETS.screen)
  })

  it('refuses a batch that acts in an app and, in an entry that names none, in whatever has focus', () => {
    expect(() => callTargets('batch', batch(
      { command: 'snapshot', args: { app: 'Safari' } },
      { command: 'press', args: { combo: 'cmd+v' } },
    ))).toThrow(/its press entry, which names no app, acts in whatever app has focus/)
    expect(callTargets('batch', batch({ command: 'press', args: { combo: 'return' } }))).toEqual({ windowIds: [], snapshotIds: [], focused: true })
    expect(callTargets('batch', batch({ command: 'press', args: { combo: 'return', app: 'Notes' } })).focused).toBeUndefined()
  })

  it('marks a call that acts in whatever app has focus', () => {
    expect(callTargets('press', { argv: ['--', 'return'] }).focused).toBe(true)
    expect(callTargets('snapshot', { argv: ['-i'] }).focused).toBe(true)
    expect(callTargets('snapshot', { argv: ['--surface=menu'] }).focused).toBe(true)
    expect(callTargets('snapshot', { argv: ['--root=@s1:e2'] }).focused).toBeUndefined()
    expect(callTargets('press', { argv: ['--window-id=w-1', '--', 'return'] }).focused).toBeUndefined()
    expect(callTargets('click', { argv: ['--', '@s1:e2'] }).focused).toBeUndefined()
  })

  it('refuses a call that names an app and another target', () => {
    expect(() => callTargets('screenshot', { argv: ['--app=Notes', '--screen=0'] })).toThrow(/names Notes and Entire screen/)
    expect(() => callTargets('snapshot', { argv: ['--app=Finder', '--surface=dock'] })).toThrow(/names Finder and Entire screen/)
  })

  it('reads a shell surface as the shell, not the focused app', () => {
    expect(callTargets('snapshot', { argv: ['--surface=dock'] })).toEqual({ windowIds: [], snapshotIds: [], system: SYSTEM_TARGETS.screen })
    expect(callTargets('find', { argv: ['--surface', 'menu-bar-extras', '--name', 'Wi-Fi'] }).system).toBe(SYSTEM_TARGETS.screen)
    expect(callTargets('snapshot', { argv: ['--surface=notification-center'] }).system).toBe(SYSTEM_TARGETS.notifications)
    expect(callTargets('batch', batch({ command: 'snapshot', args: { surface: 'spotlight' } })).system).toBe(SYSTEM_TARGETS.screen)
  })

  it('reads a notification command\'s app as a filter on notifications', () => {
    expect(callTargets('dismiss-all-notifications', { argv: ['--app=Mail'] })).toEqual({ windowIds: [], snapshotIds: [], system: SYSTEM_TARGETS.notifications })
    expect(callTargets('wait', { argv: ['--notification', '--app', 'Mail'] }).app).toBeUndefined()
  })

  it('reads launch\'s and close-app\'s app from their positional, past flag values', () => {
    expect(callTargets('launch', { argv: ['Safari', '--timeout', '5000'] }).app).toBe('Safari')
    expect(callTargets('launch', { argv: ['--timeout', '5000', 'Safari'] }).app).toBe('Safari')
    expect(callTargets('close-app', { argv: ['Notes', '--wait-timeout', '100'] }).app).toBe('Notes')
    expect(callTargets('launch', { argv: ['--activate', 'Safari'] }).app).toBe('Safari')
    expect(() => callTargets('launch', { argv: ['Safari', 'Mail'] })).toThrow(/takes one app/)
  })

  it('reads mouse-wheel\'s --x and --y as its point', () => {
    expect(callTargets('mouse-wheel', { argv: ['--x=-100', '--y', '40', '--dy=-3'] }).points).toEqual([{ x: -100, y: 40 }])
    expect(callTargets('batch', batch({ command: 'mouse-wheel', args: { x: 5, y: 6 } })).points).toEqual([{ x: 5, y: 6 }])
    expect(callTargets('move-window', { argv: ['--app=Notes', '--x=0', '--y=0'] }).points).toBeUndefined()
  })
})

describe('permissionLevelOf', () => {
  it('lets listing, help and the guides run on the read-only level', () => {
    expect(permissionLevelOf('list-apps')).toBe('list_apps_windows')
    expect(permissionLevelOf('list-windows')).toBe('list_apps_windows')
    expect(permissionLevelOf('skills', { argv: ['get', 'desktop'] })).toBe('list_apps_windows')
    expect(permissionLevelOf('mouse-click', { argv: ['--help'] })).toBe('list_apps_windows')
    expect(permissionLevelOf('snapshot', { argv: [] })).toBe('use_application')
    expect(permissionLevelOf('clipboard-get', { argv: [] })).toBe('use_application')
  })

  it('lets a wait that looks inside no app run at the read-only level', () => {
    expect(permissionLevelOf('wait', { argv: ['500'] })).toBe('list_apps_windows')
    expect(permissionLevelOf('wait', { argv: ['--event', 'window-opened', '--window', 'Untitled'] })).toBe('list_apps_windows')
    expect(permissionLevelOf('wait', { argv: ['--text', 'Saved', '--app', 'TextEdit'] })).toBe('use_application')
    expect(permissionLevelOf('wait', { argv: ['--element', '@s1:e1'] })).toBe('use_application')
    expect(permissionLevelOf('wait', { argv: ['--notification'] })).toBe('use_application')
  })
})

describe('snapshotIdOfRef', () => {
  it('reads the snapshot out of a qualified ref', () => {
    expect(snapshotIdOfRef('@s8f3k2p9:e12')).toBe('s8f3k2p9')
    expect(snapshotIdOfRef('@e12')).toBeUndefined()
    expect(snapshotIdOfRef('Finder')).toBeUndefined()
  })
})
