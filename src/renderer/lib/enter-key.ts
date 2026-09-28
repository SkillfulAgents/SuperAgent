/**
 * True while an input method (Japanese, Chinese, Korean) is composing, so a
 * key such as Enter confirms a candidate rather than acting on the text box.
 * Safari fires the confirming Enter after `compositionend`, with `isComposing`
 * false; only its keyCode 229 marks it.
 */
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || (event.key === 'Enter' && event.keyCode === 229)
}

/**
 * True for the Enter that submits a text box: Enter without Shift, outside
 * input-method composition. On touch (coarse pointer, no physical Shift key)
 * plain Enter must insert a newline — the user taps the submit button instead.
 * Otherwise every Return, including the keyboard's autocorrect-accept, would
 * submit the text mid-thought. Cmd/Ctrl+Enter submits everywhere.
 */
export function isSubmitEnter(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return false
  if (event.metaKey || event.ctrlKey) return true
  return !(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches)
}
