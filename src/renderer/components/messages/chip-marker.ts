/** `[[kind:referent|label]]` — one grammar, kind name in the first capture. */
export const CHIP_MARKER = /\[\[([a-z][a-z0-9_]*):([^|\]]+)\|([^\]]+)\]\]/g

export function formatChipMarker(kind: string, referent: string, label: string): string {
  return `[[${kind}:${referent}|${encodeURIComponent(label)}]]`
}

export function parseChipMarker(raw: string): { kind: string; referent: string; label: string } | null {
  const match = new RegExp(CHIP_MARKER.source).exec(raw)
  if (!match || match[0] !== raw) return null
  try {
    return { kind: match[1], referent: match[2], label: decodeURIComponent(match[3]) }
  } catch {
    return null
  }
}
