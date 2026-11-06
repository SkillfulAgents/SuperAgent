/** Inline `code` spans styled, everything else plain text. Never parses other Markdown, so `*`, `_` and brackets show as written. */
export function InlineCode({ text }: { text: string }) {
  return text.split(/`([^`\n]+)`/).map((part, index) => index % 2
    ? <code key={index} className="rounded bg-muted px-1 py-px font-mono text-[12px] text-foreground/80 [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">{part}</code>
    : part)
}
