/**
 * A Markdown file's leading `---` block, when it is metadata (its first line that isn't blank or a `#` comment is
 * `key: …`), and the rest. A file that only opens with a rule keeps it. The body keeps the block's lines as blank ones,
 * which Markdown ignores, so every line after it keeps its number for comments that point at it.
 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  const first = match?.[1].split(/\r?\n/).find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  if (!match || !first || !/^[A-Za-z_][\w.-]*:(?:[ \t]|$)/.test(first)) return { frontmatter: null, body: text }
  return { frontmatter: match[1], body: match[0].replace(/[^\n]/g, '') + text.slice(match[0].length) }
}
