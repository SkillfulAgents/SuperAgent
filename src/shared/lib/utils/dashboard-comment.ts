/**
 * The block a dashboard comment carries for the agent: which dashboard, the
 * page, the pin, the console. It follows the person's comment and comes before
 * the attached-files block (the screenshot). The bubble lifts it off and shows
 * it folded, so the person reads their own words.
 */
const MARKER = '[Dashboard comment context:]'

export function appendDashboardCommentContext(message: string, context: string): string {
  const block = `${MARKER}\n${context.trim()}`
  return message ? `${message}\n\n${block}` : block
}

/**
 * Lift the context block off message text. It runs from its marker to the end,
 * so it is read after the trailing blocks written behind it are gone. The first
 * marker wins: the page's console output inside the block may quote one.
 */
export function parseDashboardCommentContext(text: string): { cleanText: string; context: string | null } {
  const at = text.startsWith(`${MARKER}\n`) ? 0 : text.indexOf(`\n\n${MARKER}\n`)
  if (at === -1) return { cleanText: text, context: null }
  const start = at === 0 ? 0 : at + 2
  const context = text.slice(start + MARKER.length + 1).trim()
  return { cleanText: text.slice(0, at).trimEnd(), context: context || null }
}
