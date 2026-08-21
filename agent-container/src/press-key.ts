/**
 * Keyboard-key validation for browser_press.
 *
 * agent-browser's `press` forwards any string to CDP and reports success even
 * when the string is not a key, so `press "4242424242424242"` types nothing
 * while returning "Pressed" (browser-tools audit C4) — which taught agents to
 * enter card numbers one digit per model round-trip. Reject non-keys up front
 * and point the model at the right tool for typing text.
 */

const NAMED_KEYS = new Set(
  [
    'enter', 'tab', 'escape', 'backspace', 'delete', 'insert',
    'home', 'end', 'pageup', 'pagedown',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    'space', 'capslock', 'numlock', 'scrolllock', 'printscreen', 'pause', 'contextmenu',
    'shift', 'control', 'alt', 'meta',
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  ]
)

const MODIFIERS = new Set(['control', 'ctrl', 'shift', 'alt', 'option', 'meta', 'cmd', 'command', 'super'])

function isSingleKey(token: string): boolean {
  if (token.length === 1) return true // any printable character
  const lower = token.toLowerCase()
  if (NAMED_KEYS.has(lower)) return true
  // CDP key codes like KeyA / Digit5 / Numpad3
  return /^(key[a-z]|digit[0-9]|numpad[0-9])$/.test(lower)
}

/**
 * Returns null when `key` is a valid single key or modifier combo
 * ("Enter", "ArrowDown", "Control+a", "Control+Shift+K"), otherwise an
 * actionable error message.
 */
export function validatePressKey(key: string): string | null {
  const trimmed = key.trim()
  if (trimmed.length === 0) return 'key is required'
  if (trimmed.length === 1) return null // any printable character, including "+"

  // Trailing "+" (e.g. "Control++") — the final key is the plus character.
  const tokens = trimmed.endsWith('+')
    ? [...trimmed.slice(0, -2).split('+').filter(Boolean), '+']
    : trimmed.split('+')

  const finalKey = tokens[tokens.length - 1]
  const mods = tokens.slice(0, -1)

  if (isSingleKey(finalKey) && mods.every(m => MODIFIERS.has(m.toLowerCase()))) {
    return null
  }

  return `"${key}" is not a keyboard key. browser_press presses ONE key (or a modifier combo) like "Enter", "Tab", "ArrowDown", "Control+a" — it cannot type text. To type text, use browser_type (types real keystrokes into the focused element, or focuses a ref first); to replace an input's content, use browser_fill.`
}
