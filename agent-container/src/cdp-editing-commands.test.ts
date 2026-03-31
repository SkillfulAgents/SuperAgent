import { describe, it, expect } from 'vitest'
import { getEditingCommands, macEditingCommands } from './cdp-editing-commands'

// CDP modifier bitmask values (matches front-end modifierFlags):
const ALT = 1
const CTRL = 2
const META = 4
const SHIFT = 8

describe('macEditingCommands map', () => {
  it('loads a non-empty map', () => {
    expect(Object.keys(macEditingCommands).length).toBeGreaterThan(0)
  })

  it('contains known entries from Playwright', () => {
    expect(macEditingCommands['Meta+KeyA']).toBe('selectAll:')
    expect(macEditingCommands['Meta+KeyC']).toBe('copy:')
    expect(macEditingCommands['Meta+KeyV']).toBe('paste:')
    expect(macEditingCommands['Meta+KeyX']).toBe('cut:')
    expect(macEditingCommands['Meta+KeyZ']).toBe('undo:')
    expect(macEditingCommands['Shift+Meta+KeyZ']).toBe('redo:')
    expect(macEditingCommands['Backspace']).toBe('deleteBackward:')
    expect(macEditingCommands['Delete']).toBe('deleteForward:')
  })
})

describe('getEditingCommands', () => {
  // --- Single-key (no modifiers) ---

  it('returns command for Backspace with no modifiers', () => {
    expect(getEditingCommands('Backspace', 0)).toEqual(['deleteBackward'])
  })

  it('returns command for Delete with no modifiers', () => {
    expect(getEditingCommands('Delete', 0)).toEqual(['deleteForward'])
  })

  it('returns command for Enter with no modifiers', () => {
    // Enter maps to insertNewline: which starts with "insert" → filtered out
    expect(getEditingCommands('Enter', 0)).toEqual([])
  })

  it('returns command for ArrowUp with no modifiers', () => {
    expect(getEditingCommands('ArrowUp', 0)).toEqual(['moveUp'])
  })

  it('returns command for ArrowDown with no modifiers', () => {
    expect(getEditingCommands('ArrowDown', 0)).toEqual(['moveDown'])
  })

  it('returns command for ArrowLeft with no modifiers', () => {
    expect(getEditingCommands('ArrowLeft', 0)).toEqual(['moveLeft'])
  })

  it('returns command for ArrowRight with no modifiers', () => {
    expect(getEditingCommands('ArrowRight', 0)).toEqual(['moveRight'])
  })

  it('returns empty for unknown key', () => {
    expect(getEditingCommands('F13', 0)).toEqual([])
  })

  it('returns empty for a printable character with no modifiers', () => {
    expect(getEditingCommands('KeyA', 0)).toEqual([])
  })

  // --- Meta (Cmd) combos ---

  it('Cmd+A → selectAll', () => {
    expect(getEditingCommands('KeyA', META)).toEqual(['selectAll'])
  })

  it('Cmd+C → copy', () => {
    expect(getEditingCommands('KeyC', META)).toEqual(['copy'])
  })

  it('Cmd+X → cut', () => {
    expect(getEditingCommands('KeyX', META)).toEqual(['cut'])
  })

  it('Cmd+V → paste', () => {
    expect(getEditingCommands('KeyV', META)).toEqual(['paste'])
  })

  it('Cmd+Z → undo', () => {
    expect(getEditingCommands('KeyZ', META)).toEqual(['undo'])
  })

  it('Cmd+Backspace → deleteToBeginningOfLine', () => {
    expect(getEditingCommands('Backspace', META)).toEqual(['deleteToBeginningOfLine'])
  })

  it('Cmd+ArrowLeft → moveToLeftEndOfLine', () => {
    expect(getEditingCommands('ArrowLeft', META)).toEqual(['moveToLeftEndOfLine'])
  })

  it('Cmd+ArrowRight → moveToRightEndOfLine', () => {
    expect(getEditingCommands('ArrowRight', META)).toEqual(['moveToRightEndOfLine'])
  })

  it('Cmd+ArrowUp → moveToBeginningOfDocument', () => {
    expect(getEditingCommands('ArrowUp', META)).toEqual(['moveToBeginningOfDocument'])
  })

  it('Cmd+ArrowDown → moveToEndOfDocument', () => {
    expect(getEditingCommands('ArrowDown', META)).toEqual(['moveToEndOfDocument'])
  })

  // --- Shift combos ---

  it('Shift+ArrowLeft → moveLeftAndModifySelection', () => {
    expect(getEditingCommands('ArrowLeft', SHIFT)).toEqual(['moveLeftAndModifySelection'])
  })

  it('Shift+ArrowRight → moveRightAndModifySelection', () => {
    expect(getEditingCommands('ArrowRight', SHIFT)).toEqual(['moveRightAndModifySelection'])
  })

  it('Shift+ArrowUp → moveUpAndModifySelection', () => {
    expect(getEditingCommands('ArrowUp', SHIFT)).toEqual(['moveUpAndModifySelection'])
  })

  it('Shift+ArrowDown → moveDownAndModifySelection', () => {
    expect(getEditingCommands('ArrowDown', SHIFT)).toEqual(['moveDownAndModifySelection'])
  })

  it('Shift+Home → moveToBeginningOfDocumentAndModifySelection', () => {
    expect(getEditingCommands('Home', SHIFT)).toEqual(['moveToBeginningOfDocumentAndModifySelection'])
  })

  it('Shift+End → moveToEndOfDocumentAndModifySelection', () => {
    expect(getEditingCommands('End', SHIFT)).toEqual(['moveToEndOfDocumentAndModifySelection'])
  })

  it('Shift+Backspace → deleteBackward', () => {
    expect(getEditingCommands('Backspace', SHIFT)).toEqual(['deleteBackward'])
  })

  it('Shift+Delete → deleteForward', () => {
    expect(getEditingCommands('Delete', SHIFT)).toEqual(['deleteForward'])
  })

  // --- Shift+Meta combos (two modifiers — tests key ordering) ---

  it('Shift+Cmd+Z → redo', () => {
    expect(getEditingCommands('KeyZ', SHIFT | META)).toEqual(['redo'])
  })

  it('Shift+Cmd+ArrowLeft → moveToLeftEndOfLineAndModifySelection', () => {
    expect(getEditingCommands('ArrowLeft', SHIFT | META)).toEqual(['moveToLeftEndOfLineAndModifySelection'])
  })

  it('Shift+Cmd+ArrowRight → moveToRightEndOfLineAndModifySelection', () => {
    expect(getEditingCommands('ArrowRight', SHIFT | META)).toEqual(['moveToRightEndOfLineAndModifySelection'])
  })

  it('Shift+Cmd+ArrowUp → moveToBeginningOfDocumentAndModifySelection', () => {
    expect(getEditingCommands('ArrowUp', SHIFT | META)).toEqual(['moveToBeginningOfDocumentAndModifySelection'])
  })

  it('Shift+Cmd+ArrowDown → moveToEndOfDocumentAndModifySelection', () => {
    expect(getEditingCommands('ArrowDown', SHIFT | META)).toEqual(['moveToEndOfDocumentAndModifySelection'])
  })

  it('Shift+Cmd+Backspace → deleteToBeginningOfLine', () => {
    expect(getEditingCommands('Backspace', SHIFT | META)).toEqual(['deleteToBeginningOfLine'])
  })

  // --- Control combos ---

  it('Ctrl+A → moveToBeginningOfParagraph', () => {
    expect(getEditingCommands('KeyA', CTRL)).toEqual(['moveToBeginningOfParagraph'])
  })

  it('Ctrl+E → moveToEndOfParagraph', () => {
    expect(getEditingCommands('KeyE', CTRL)).toEqual(['moveToEndOfParagraph'])
  })

  it('Ctrl+D → deleteForward', () => {
    expect(getEditingCommands('KeyD', CTRL)).toEqual(['deleteForward'])
  })

  it('Ctrl+H → deleteBackward', () => {
    expect(getEditingCommands('KeyH', CTRL)).toEqual(['deleteBackward'])
  })

  it('Ctrl+K → deleteToEndOfParagraph', () => {
    expect(getEditingCommands('KeyK', CTRL)).toEqual(['deleteToEndOfParagraph'])
  })

  it('Ctrl+Backspace → deleteBackwardByDecomposingPreviousCharacter', () => {
    expect(getEditingCommands('Backspace', CTRL)).toEqual(['deleteBackwardByDecomposingPreviousCharacter'])
  })

  // --- Shift+Control combos (two modifiers — tests ordering) ---

  it('Shift+Ctrl+A → moveToBeginningOfParagraphAndModifySelection', () => {
    expect(getEditingCommands('KeyA', SHIFT | CTRL)).toEqual(['moveToBeginningOfParagraphAndModifySelection'])
  })

  it('Shift+Ctrl+E → moveToEndOfParagraphAndModifySelection', () => {
    expect(getEditingCommands('KeyE', SHIFT | CTRL)).toEqual(['moveToEndOfParagraphAndModifySelection'])
  })

  it('Shift+Ctrl+ArrowLeft → moveToLeftEndOfLineAndModifySelection', () => {
    expect(getEditingCommands('ArrowLeft', SHIFT | CTRL)).toEqual(['moveToLeftEndOfLineAndModifySelection'])
  })

  it('Shift+Ctrl+ArrowRight → moveToRightEndOfLineAndModifySelection', () => {
    expect(getEditingCommands('ArrowRight', SHIFT | CTRL)).toEqual(['moveToRightEndOfLineAndModifySelection'])
  })

  // --- Alt combos ---

  it('Alt+Backspace → deleteWordBackward', () => {
    expect(getEditingCommands('Backspace', ALT)).toEqual(['deleteWordBackward'])
  })

  it('Alt+Delete → deleteWordForward', () => {
    expect(getEditingCommands('Delete', ALT)).toEqual(['deleteWordForward'])
  })

  it('Alt+ArrowLeft → moveWordLeft', () => {
    expect(getEditingCommands('ArrowLeft', ALT)).toEqual(['moveWordLeft'])
  })

  it('Alt+ArrowRight → moveWordRight', () => {
    expect(getEditingCommands('ArrowRight', ALT)).toEqual(['moveWordRight'])
  })

  // --- Shift+Alt combos (two modifiers — tests ordering) ---

  it('Shift+Alt+ArrowLeft → moveWordLeftAndModifySelection', () => {
    expect(getEditingCommands('ArrowLeft', SHIFT | ALT)).toEqual(['moveWordLeftAndModifySelection'])
  })

  it('Shift+Alt+ArrowRight → moveWordRightAndModifySelection', () => {
    expect(getEditingCommands('ArrowRight', SHIFT | ALT)).toEqual(['moveWordRightAndModifySelection'])
  })

  it('Shift+Alt+ArrowUp → moveParagraphBackwardAndModifySelection', () => {
    expect(getEditingCommands('ArrowUp', SHIFT | ALT)).toEqual(['moveParagraphBackwardAndModifySelection'])
  })

  it('Shift+Alt+ArrowDown → moveParagraphForwardAndModifySelection', () => {
    expect(getEditingCommands('ArrowDown', SHIFT | ALT)).toEqual(['moveParagraphForwardAndModifySelection'])
  })

  // --- Control+Alt combos (two modifiers — tests ordering) ---

  it('Ctrl+Alt+B → moveWordBackward', () => {
    expect(getEditingCommands('KeyB', CTRL | ALT)).toEqual(['moveWordBackward'])
  })

  it('Ctrl+Alt+F → moveWordForward', () => {
    expect(getEditingCommands('KeyF', CTRL | ALT)).toEqual(['moveWordForward'])
  })

  it('Ctrl+Alt+Backspace → deleteWordBackward', () => {
    expect(getEditingCommands('Backspace', CTRL | ALT)).toEqual(['deleteWordBackward'])
  })

  // --- Triple-modifier combos (Shift+Control+Alt — tests full ordering) ---

  it('Shift+Ctrl+Alt+B → moveWordBackwardAndModifySelection', () => {
    expect(getEditingCommands('KeyB', SHIFT | CTRL | ALT)).toEqual(['moveWordBackwardAndModifySelection'])
  })

  it('Shift+Ctrl+Alt+F → moveWordForwardAndModifySelection', () => {
    expect(getEditingCommands('KeyF', SHIFT | CTRL | ALT)).toEqual(['moveWordForwardAndModifySelection'])
  })

  it('Shift+Ctrl+Alt+Backspace → deleteWordBackward', () => {
    expect(getEditingCommands('Backspace', SHIFT | CTRL | ALT)).toEqual(['deleteWordBackward'])
  })

  // --- Multi-command entries ---

  it('Ctrl+O returns multiple commands (filtered)', () => {
    // macEditingCommands has ["insertNewlineIgnoringFieldEditor:", "moveBackward:"]
    // "insertNewlineIgnoringFieldEditor:" starts with "insert" → filtered out
    expect(getEditingCommands('KeyO', CTRL)).toEqual(['moveBackward'])
  })

  it('Alt+ArrowUp returns multiple commands (filtered)', () => {
    // macEditingCommands has ["moveBackward:", "moveToBeginningOfParagraph:"]
    // Neither starts with "insert" → both kept
    expect(getEditingCommands('ArrowUp', ALT)).toEqual(['moveBackward', 'moveToBeginningOfParagraph'])
  })

  // --- Insert-filter verification ---

  it('filters out commands starting with "insert"', () => {
    // Enter → insertNewline: → filtered
    expect(getEditingCommands('Enter', 0)).toEqual([])
    // Shift+Enter → insertNewline: → filtered
    expect(getEditingCommands('Enter', SHIFT)).toEqual([])
    // Alt+Enter → insertNewlineIgnoringFieldEditor: → filtered
    expect(getEditingCommands('Enter', ALT)).toEqual([])
  })

  // --- Colon-stripping verification ---

  it('strips trailing colon from commands', () => {
    // Verify raw map has colons
    expect(macEditingCommands['Backspace']).toBe('deleteBackward:')
    // Verify getEditingCommands strips them
    expect(getEditingCommands('Backspace', 0)).toEqual(['deleteBackward'])
  })

  // --- Edge cases ---

  it('returns empty for unrecognized modifier combinations', () => {
    // Meta+Ctrl+A — not in the map (only Ctrl+A and Meta+KeyA exist separately)
    expect(getEditingCommands('KeyA', META | CTRL)).toEqual([])
  })

  it('returns empty for all four modifiers combined', () => {
    expect(getEditingCommands('KeyA', SHIFT | CTRL | ALT | META)).toEqual([])
  })

  it('returns empty for modifiers=0 with printable key code', () => {
    expect(getEditingCommands('KeyZ', 0)).toEqual([])
    expect(getEditingCommands('KeyC', 0)).toEqual([])
  })

  // --- Exhaustive: verify every key in macEditingCommands is reachable ---

  it('every entry in macEditingCommands is reachable via getEditingCommands', () => {
    const modifierNameToBit: Record<string, number> = {
      'Shift': SHIFT,
      'Control': CTRL,
      'Alt': ALT,
      'Meta': META,
    }

    for (const [shortcut, rawCmds] of Object.entries(macEditingCommands)) {
      const parts = shortcut.split('+')
      const code = parts[parts.length - 1]
      let modifiers = 0
      for (let i = 0; i < parts.length - 1; i++) {
        modifiers |= modifierNameToBit[parts[i]] || 0
      }

      const result = getEditingCommands(code, modifiers)
      const expected = (typeof rawCmds === 'string' ? [rawCmds] : rawCmds)
        .filter(c => !c.startsWith('insert'))
        .map(c => c.endsWith(':') ? c.slice(0, -1) : c)

      expect(result, `shortcut "${shortcut}" should be reachable`).toEqual(expected)
    }
  })
})
