/**
 * Flatten a markdown body into single-line plain text for truncated list
 * previews (e.g. the notification inbox row). This is presentational-only —
 * the full body is always rendered through ReactMarkdown with the URL-scheme
 * allowlist; nothing security-relevant happens here.
 */
export function stripMarkdownPreview(markdown: string): string {
  return (
    markdown
      // Code blocks first, so their content doesn't leak fence/language noise
      .replace(/```[\s\S]*?```/g, ' ')
      // Images: keep the alt text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Links: keep the label
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Inline code
      .replace(/`([^`]+)`/g, '$1')
      // Bold / italic / strikethrough (longest markers first)
      .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(.+?)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      // Line-anchored syntax: headings, blockquotes, list markers, hrules
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
      // Collapse to one line
      .replace(/\s+/g, ' ')
      .trim()
  )
}
