/**
 * The note the dispatch launcher adds to a message sent with its computer-use
 * toggle on: the agent may use any app without asking, and the screenshot the
 * launcher attached is the person's screen as they sent it. Written last, after
 * the dictation note, and lifted off again before anything reads the message
 * back, so the person never sees it. Typed text cannot forge it: the composer
 * escapes a typed `[`. The permission itself is the session's grant, not this
 * note.
 */
const MARKER = '[Computer use:'
const TRAILING_NOTE = /(?:^|\n\n)\[Computer use:[^\n]*\]\s*$/

/** `screenshotName`: the attached screenshot's file name, when one was taken. */
export function appendComputerUseNote(message: string, screenshotName?: string): string {
  // A name with a bracket or a line break would end the note early.
  const name = screenshotName?.replace(/[[\]\n\r]/g, ' ').trim()
  const screen = name
    ? ` The attached "${name}" is their screen as they sent this: look at it first, it is what "this" and "here" refer to.`
    : ''
  const note = `${MARKER} the user sent this from their desktop and allowed you to use any app on it without asking.${screen}]`
  return message ? `${message}\n\n${note}` : note
}

/** Lift the computer-use note off the end of message text. */
export function parseComputerUseNote(text: string): { cleanText: string; computerUse: boolean } {
  const match = TRAILING_NOTE.exec(text)
  if (!match) return { cleanText: text, computerUse: false }
  return { cleanText: text.slice(0, match.index).trimEnd(), computerUse: true }
}
