import { load, JSON_SCHEMA } from 'js-yaml'

/**
 * A Markdown file's leading `---` block, when it parses as YAML named fields, and the rest. A file that only opens
 * with a rule keeps it. The body keeps the block's lines as blank ones, which Markdown ignores, so every line after it
 * keeps its number for comments that point at it.
 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match || !isMapping(match[1])) return { frontmatter: null, body: text }
  return { frontmatter: match[1], body: match[0].replace(/[^\n]/g, '') + text.slice(match[0].length) }
}

function isMapping(yaml: string): boolean {
  try {
    const parsed = load(yaml, { schema: JSON_SCHEMA })
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}
