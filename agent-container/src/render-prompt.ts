import Mustache from 'mustache'

// Prompts are Markdown, not HTML, and already contain literal `{{ }}` as
// instructional content (memory-format examples in system-prompt.md). Render
// with `<% %>` delimiters so those literals survive, and a per-call identity
// `escape` so quotes, paths, and `&`/`<` in prompt text are inserted verbatim.
// Per-call (not the `Mustache.escape` singleton) keeps escaping scoped to this
// renderer instead of mutating shared module state for the whole process.
export function renderPrompt(template: string, vars: object): string {
  const rendered = Mustache.render(template, vars, {}, { tags: ['<%', '%>'], escape: (value) => value })
  // Trailing sections each end in a newline; whether the prompt ends with one is
  // an artifact of which sections rendered, so normalize it away.
  return rendered.trimEnd()
}
