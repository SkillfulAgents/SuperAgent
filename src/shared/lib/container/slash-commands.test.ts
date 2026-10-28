import { describe, expect, it } from 'vitest'
import { mergeCanonicalSlashCommands, repairLegacySlashCommands } from './slash-commands'

describe('mergeCanonicalSlashCommands', () => {
  it('uses CLI slugs with SDK descriptions and argument hints', () => {
    expect(mergeCanonicalSlashCommands(
      ['order-canvas-print'],
      [{ name: 'Order Canvas Print', description: 'Order a framed canvas', argumentHint: '<image>' }],
    )).toEqual([
      { name: 'order-canvas-print', description: 'Order a framed canvas', argumentHint: '<image>' },
    ])
  })

  it('does not attach ambiguous rich details to a canonical command', () => {
    expect(mergeCanonicalSlashCommands(
      ['foo-bar'],
      [
        { name: 'Foo Bar', description: 'First', argumentHint: '' },
        { name: 'foo_bar', description: 'Second', argumentHint: '' },
      ],
    )).toEqual([{ name: 'foo-bar', description: '', argumentHint: '' }])
  })
})

describe('repairLegacySlashCommands', () => {
  it('repairs persisted display titles without losing help text', () => {
    expect(repairLegacySlashCommands([
      { name: 'Order Canvas Print', description: 'Order a framed canvas', argumentHint: '<image>' },
      { name: 'compact', description: 'Free up context', argumentHint: '' },
    ])).toEqual({
      changed: true,
      commands: [
        { name: 'order-canvas-print', description: 'Order a framed canvas', argumentHint: '<image>' },
        { name: 'compact', description: 'Free up context', argumentHint: '' },
      ],
    })
  })

  it('leaves canonical names untouched', () => {
    const commands = [{ name: '__remote-workflow', description: 'Run it', argumentHint: '' }]
    expect(repairLegacySlashCommands(commands)).toEqual({ changed: false, commands })
  })

  it('preserves plugin namespaces while repairing their display title', () => {
    expect(repairLegacySlashCommands([
      { name: 'canvas-tools:Order Canvas Print', description: 'Order it', argumentHint: '' },
    ]).commands[0].name).toBe('canvas-tools:order-canvas-print')
  })
})
