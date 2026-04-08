// CDP keyboard shortcut support.
// Chrome's CDP Input.dispatchKeyEvent needs a `commands` array to trigger
// editing actions (selectAll, cut, undo, etc.) on all platforms.
//
// This map was extracted from playwright-core's macEditingCommands and inlined
// here because agent-browser v0.20.0+ no longer bundles playwright-core.

export const macEditingCommands: Record<string, string | string[]> = {
  'Backspace': 'deleteBackward:',
  'Enter': 'insertNewline:',
  'NumpadEnter': 'insertNewline:',
  'Escape': 'cancelOperation:',
  'ArrowUp': 'moveUp:',
  'ArrowDown': 'moveDown:',
  'ArrowLeft': 'moveLeft:',
  'ArrowRight': 'moveRight:',
  'F5': 'complete:',
  'Delete': 'deleteForward:',
  'Home': 'scrollToBeginningOfDocument:',
  'End': 'scrollToEndOfDocument:',
  'PageUp': 'scrollPageUp:',
  'PageDown': 'scrollPageDown:',
  'Shift+Backspace': 'deleteBackward:',
  'Shift+Enter': 'insertNewline:',
  'Shift+NumpadEnter': 'insertNewline:',
  'Shift+Escape': 'cancelOperation:',
  'Shift+ArrowUp': 'moveUpAndModifySelection:',
  'Shift+ArrowDown': 'moveDownAndModifySelection:',
  'Shift+ArrowLeft': 'moveLeftAndModifySelection:',
  'Shift+ArrowRight': 'moveRightAndModifySelection:',
  'Shift+F5': 'complete:',
  'Shift+Delete': 'deleteForward:',
  'Shift+Home': 'moveToBeginningOfDocumentAndModifySelection:',
  'Shift+End': 'moveToEndOfDocumentAndModifySelection:',
  'Shift+PageUp': 'pageUpAndModifySelection:',
  'Shift+PageDown': 'pageDownAndModifySelection:',
  'Shift+Numpad5': 'delete:',
  'Control+Tab': 'selectNextKeyView:',
  'Control+Enter': 'insertLineBreak:',
  'Control+NumpadEnter': 'insertLineBreak:',
  'Control+Quote': 'insertSingleQuoteIgnoringSubstitution:',
  'Control+KeyA': 'moveToBeginningOfParagraph:',
  'Control+KeyB': 'moveBackward:',
  'Control+KeyD': 'deleteForward:',
  'Control+KeyE': 'moveToEndOfParagraph:',
  'Control+KeyF': 'moveForward:',
  'Control+KeyH': 'deleteBackward:',
  'Control+KeyK': 'deleteToEndOfParagraph:',
  'Control+KeyL': 'centerSelectionInVisibleArea:',
  'Control+KeyN': 'moveDown:',
  'Control+KeyO': ['insertNewlineIgnoringFieldEditor:', 'moveBackward:'],
  'Control+KeyP': 'moveUp:',
  'Control+KeyT': 'transpose:',
  'Control+KeyV': 'pageDown:',
  'Control+KeyY': 'yank:',
  'Control+Backspace': 'deleteBackwardByDecomposingPreviousCharacter:',
  'Control+ArrowUp': 'scrollPageUp:',
  'Control+ArrowDown': 'scrollPageDown:',
  'Control+ArrowLeft': 'moveToLeftEndOfLine:',
  'Control+ArrowRight': 'moveToRightEndOfLine:',
  'Shift+Control+Enter': 'insertLineBreak:',
  'Shift+Control+NumpadEnter': 'insertLineBreak:',
  'Shift+Control+Tab': 'selectPreviousKeyView:',
  'Shift+Control+Quote': 'insertDoubleQuoteIgnoringSubstitution:',
  'Shift+Control+KeyA': 'moveToBeginningOfParagraphAndModifySelection:',
  'Shift+Control+KeyB': 'moveBackwardAndModifySelection:',
  'Shift+Control+KeyE': 'moveToEndOfParagraphAndModifySelection:',
  'Shift+Control+KeyF': 'moveForwardAndModifySelection:',
  'Shift+Control+KeyN': 'moveDownAndModifySelection:',
  'Shift+Control+KeyP': 'moveUpAndModifySelection:',
  'Shift+Control+KeyV': 'pageDownAndModifySelection:',
  'Shift+Control+Backspace': 'deleteBackwardByDecomposingPreviousCharacter:',
  'Shift+Control+ArrowUp': 'scrollPageUp:',
  'Shift+Control+ArrowDown': 'scrollPageDown:',
  'Shift+Control+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection:',
  'Shift+Control+ArrowRight': 'moveToRightEndOfLineAndModifySelection:',
  'Alt+Backspace': 'deleteWordBackward:',
  'Alt+Enter': 'insertNewlineIgnoringFieldEditor:',
  'Alt+NumpadEnter': 'insertNewlineIgnoringFieldEditor:',
  'Alt+Escape': 'complete:',
  'Alt+ArrowUp': ['moveBackward:', 'moveToBeginningOfParagraph:'],
  'Alt+ArrowDown': ['moveForward:', 'moveToEndOfParagraph:'],
  'Alt+ArrowLeft': 'moveWordLeft:',
  'Alt+ArrowRight': 'moveWordRight:',
  'Alt+Delete': 'deleteWordForward:',
  'Alt+PageUp': 'pageUp:',
  'Alt+PageDown': 'pageDown:',
  'Shift+Alt+Backspace': 'deleteWordBackward:',
  'Shift+Alt+Enter': 'insertNewlineIgnoringFieldEditor:',
  'Shift+Alt+NumpadEnter': 'insertNewlineIgnoringFieldEditor:',
  'Shift+Alt+Escape': 'complete:',
  'Shift+Alt+ArrowUp': 'moveParagraphBackwardAndModifySelection:',
  'Shift+Alt+ArrowDown': 'moveParagraphForwardAndModifySelection:',
  'Shift+Alt+ArrowLeft': 'moveWordLeftAndModifySelection:',
  'Shift+Alt+ArrowRight': 'moveWordRightAndModifySelection:',
  'Shift+Alt+Delete': 'deleteWordForward:',
  'Shift+Alt+PageUp': 'pageUp:',
  'Shift+Alt+PageDown': 'pageDown:',
  'Control+Alt+KeyB': 'moveWordBackward:',
  'Control+Alt+KeyF': 'moveWordForward:',
  'Control+Alt+Backspace': 'deleteWordBackward:',
  'Shift+Control+Alt+KeyB': 'moveWordBackwardAndModifySelection:',
  'Shift+Control+Alt+KeyF': 'moveWordForwardAndModifySelection:',
  'Shift+Control+Alt+Backspace': 'deleteWordBackward:',
  'Meta+NumpadSubtract': 'cancel:',
  'Meta+Backspace': 'deleteToBeginningOfLine:',
  'Meta+ArrowUp': 'moveToBeginningOfDocument:',
  'Meta+ArrowDown': 'moveToEndOfDocument:',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine:',
  'Meta+ArrowRight': 'moveToRightEndOfLine:',
  'Shift+Meta+NumpadSubtract': 'cancel:',
  'Shift+Meta+Backspace': 'deleteToBeginningOfLine:',
  'Shift+Meta+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection:',
  'Shift+Meta+ArrowDown': 'moveToEndOfDocumentAndModifySelection:',
  'Shift+Meta+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection:',
  'Shift+Meta+ArrowRight': 'moveToRightEndOfLineAndModifySelection:',
  'Meta+KeyA': 'selectAll:',
  'Meta+KeyC': 'copy:',
  'Meta+KeyX': 'cut:',
  'Meta+KeyV': 'paste:',
  'Meta+KeyZ': 'undo:',
  'Shift+Meta+KeyZ': 'redo:',
};

/**
 * Look up CDP editing commands for a key combo.
 * Matches Playwright's crInput._commandsForCode() — modifier order is
 * Shift, Control, Alt, Meta (same order Playwright iterates).
 *
 * @param code  - The KeyboardEvent.code (e.g. "KeyA", "Backspace")
 * @param modifiers - CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
 */
export function getEditingCommands(code: string, modifiers: number): string[] {
  const parts: string[] = [];
  if (modifiers & 8) parts.push('Shift');
  if (modifiers & 2) parts.push('Control');
  if (modifiers & 1) parts.push('Alt');
  if (modifiers & 4) parts.push('Meta');
  parts.push(code);
  const shortcut = parts.join('+');
  let cmds = macEditingCommands[shortcut];
  if (!cmds) return [];
  if (typeof cmds === 'string') cmds = [cmds];
  return cmds
    .filter((c: string) => !c.startsWith('insert'))
    .map((c: string) => c.endsWith(':') ? c.slice(0, -1) : c);
}
