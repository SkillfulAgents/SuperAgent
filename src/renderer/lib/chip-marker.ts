/**
 * A composer chip as the draft stores it: `[[kind:referent|label]]`, with the
 * label URI-encoded so neither part holds brackets, pipes, or whitespace. The
 * Markdown serializer escapes `[` in typed text, so an unescaped marker in a
 * draft was written by a chip.
 */
export interface Chip {
  kind: string
  referent: string
  label: string
}

const CHIP_MARKER_SOURCE = String.raw`\[\[([a-z][a-z0-9_-]*):([^|[\]\s]+)\|([^|[\]\s]+)\]\]`

export const CHIP_MARKER = new RegExp(CHIP_MARKER_SOURCE, 'g')
export const CHIP_MARKER_STICKY = new RegExp(CHIP_MARKER_SOURCE, 'y')

export function formatChipMarker({ kind, referent, label }: Chip): string {
  return `[[${kind}:${referent}|${encodeURIComponent(label.toWellFormed())}]]`
}

/** The chip a `CHIP_MARKER` match spells, or null when its label does not decode. */
export function chipFromMatch(match: readonly string[]): Chip | null {
  try {
    return { kind: match[1], referent: match[2], label: decodeURIComponent(match[3]) }
  } catch {
    return null
  }
}
