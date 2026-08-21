/**
 * Contenteditable-aware field value read-back for browser_fill / browser_type.
 *
 * Both handlers verify what landed in a field by reading it back after the
 * action. They used agent-browser's `get value`, which reads the element's
 * `.value` property. Form controls (<input>/<textarea>/<select>) expose
 * `.value`, but contenteditable widgets do NOT — `get value` returns "" for
 * them even when text is present.
 *
 * LinkedIn's message composer (and rich-text editors generally) is a
 * contenteditable <div>. So the read-back reported an empty field even after a
 * successful type, and that false-empty value was fed straight to the agent
 * ("field value is now ''"). The agent concluded its keystrokes had not landed
 * and typed again — `keyboard type` appends, so the field accumulated
 * "hellohello", "hellohellohello", ... and the agent then struggled to delete
 * the extras. Because the compose box is always contenteditable, this happened
 * on every send.
 *
 * Fix: when `get value` is empty, fall back to the element's text content
 * (`get text`), which IS populated for contenteditables. Form controls keep
 * their existing behaviour because a non-empty `get value` short-circuits.
 */

export interface FieldRead {
  /** The CLI read succeeded (exit code 0). */
  ok: boolean
  /** Trimmed stdout from the read (only meaningful when `ok`). */
  text: string
}

/**
 * Resolve the committed value of a field from its `get value` read and, when
 * that is empty/unreadable, its `get text` read.
 *
 * @param valueRead  result of `get value <ref>`
 * @param textRead   result of `get text <ref>`, or null when it was not
 *                   performed (the caller skips it when `valueRead` already
 *                   yielded a non-empty value)
 * @returns the committed value, "" when the field is genuinely empty, or null
 *          when nothing could be read back
 */
export function resolveCommittedValue(
  valueRead: FieldRead,
  textRead: FieldRead | null
): string | null {
  // Form control with content: trust `.value` directly.
  if (valueRead.ok && valueRead.text !== '') return valueRead.text

  // Empty or unreadable `.value`: a contenteditable exposes its content as
  // text, not value, so prefer a non-empty text read.
  if (textRead && textRead.ok && textRead.text !== '') return textRead.text

  // Nothing has content. Report "" if either read succeeded (genuinely empty
  // field), otherwise null (could not read the field at all).
  if (valueRead.ok || (textRead && textRead.ok)) return ''
  return null
}
