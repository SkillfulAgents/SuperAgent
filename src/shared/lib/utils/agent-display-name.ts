import { parseMarkdownWithFrontmatter } from './file-storage'

/**
 * The agent's display name from its instructions document (`CLAUDE.md`), or
 * undefined when the document is absent or names nothing. The frontmatter
 * parser coerces YAML-ambiguous scalars ("123", "true") to number or boolean;
 * those are still legitimate display names, so they are coerced back.
 */
export function displayNameFromInstructions(content: string | null | undefined): string | undefined {
  if (!content) return undefined
  let raw: unknown
  try {
    raw = parseMarkdownWithFrontmatter<{ name?: unknown }>(content).frontmatter.name
  } catch {
    return undefined
  }
  const name =
    typeof raw === 'string' ? raw
    : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw)
    : undefined
  return name?.trim() ? name : undefined
}
