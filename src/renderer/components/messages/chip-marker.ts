/** `[[kind:referent|label]]` — one grammar, kind name in the first capture. */
const CHIP_MARKER_BODY = String.raw`\[\[([a-z][a-z0-9_]*):([^|\]]+)\|([^\]]+)\]\]`

export const CHIP_MARKER = new RegExp(CHIP_MARKER_BODY, 'g')
export const CHIP_MARKER_ANCHORED = new RegExp(`^${CHIP_MARKER_BODY}$`)
export const CHIP_MARKER_STICKY = new RegExp(CHIP_MARKER_BODY, 'y')

export function formatChipMarker(kind: string, referent: string, label: string): string {
  return `[[${kind}:${referent}|${encodeURIComponent(label.toWellFormed())}]]`
}

export function parseChipMarker(raw: string): { kind: string; referent: string; label: string } | null {
  const match = CHIP_MARKER_ANCHORED.exec(raw)
  if (!match) return null
  try {
    return { kind: match[1], referent: match[2], label: decodeURIComponent(match[3]) }
  } catch {
    return null
  }
}
