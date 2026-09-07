/**
 * Human labels for model identifiers as they appear on disk and on the wire:
 *   - a full API id from a transcript (`claude-haiku-4-5-20251001`, `claude-fable-5-1`)
 *   - the slug inside a model-only agent type (`model-haiku-4-5-1cbdtsn` → `haiku-4-5`)
 * Both collapse to "Haiku 4.5" / "Fable 5.1": initialisms (three letters or
 * fewer, e.g. GPT) are upper-cased, names title-cased (Opus, Grok), and adjacent
 * numeric parts join with a dot.
 */
export function formatModelSlug(slug: string): string {
  const parts = slug.split('-').filter(Boolean).map((part) => {
    if (!/^[a-z]+$/.test(part)) return part
    return part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`
  })
  return parts.reduce((label, part, index) => {
    const separator =
      index > 0 && /^\d+$/.test(part) && /^\d+$/.test(parts[index - 1]) ? '.' : index > 0 ? ' ' : ''
    return `${label}${separator}${part}`
  }, '')
}

/** A full model id → label: drops the `claude-` vendor prefix and a trailing date stamp. */
export function formatModelId(modelId: string): string {
  const slug = modelId.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  return formatModelSlug(slug)
}
