/**
 * The note the composer adds to a message the person dictated with the mic, so
 * the agent reads it allowing for speech-to-text slips ("to" for "two"). It is
 * written last, after the mentions block, and lifted off again before anything
 * reads the message back, so the person never sees it. Typed text cannot forge
 * it: the composer escapes a typed `[`. Voice mode tells the agent once, in its
 * own notice, instead.
 */
const MARKER = '[Voice dictated:'
const NOTE = `${MARKER} the user spoke some or all of this message and speech-to-text transcribed it. Expect misheard words and homophones (e.g. "to" for "two"), missing punctuation, and names spelled phonetically. Work out what they meant.]`
const TRAILING_NOTE = /(?:^|\n\n)\[Voice dictated:[^\n]*\]\s*$/

export function appendDictationNote(message: string): string {
  return message ? `${message}\n\n${NOTE}` : NOTE
}

/** Lift the dictation note off the end of message text. */
export function parseDictationNote(text: string): { cleanText: string; dictated: boolean } {
  const match = TRAILING_NOTE.exec(text)
  if (!match) return { cleanText: text, dictated: false }
  return { cleanText: text.slice(0, match.index).trimEnd(), dictated: true }
}
