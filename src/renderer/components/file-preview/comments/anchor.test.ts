import { describe, it, expect } from 'vitest'
import { selectionToAnchor } from './anchor'

describe('selectionToAnchor', () => {
  it('keeps the precedence the comment list always used: cell, text, time, point, file', () => {
    const cell = { row: 1, col: 0, column: 'Name', value: 'Ada' }
    expect(selectionToAnchor({ text: 'Ada', cell })).toEqual({ kind: 'cell', cell })
    expect(selectionToAnchor({ text: 'teh', timestamp: 3, x: 1, y: 2 })).toEqual({ kind: 'text', quote: 'teh' })
    expect(selectionToAnchor({ text: '', timestamp: 3, x: 1, y: 2 })).toEqual({ kind: 'time', seconds: 3, point: { x: 1, y: 2 } })
    expect(selectionToAnchor({ text: '', x: 1, y: 2 })).toEqual({ kind: 'point', x: 1, y: 2 })
    expect(selectionToAnchor({ text: '' })).toEqual({ kind: 'file' })
  })
})
