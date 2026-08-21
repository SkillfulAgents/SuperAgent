/**
 * Guardrails for the browser_eval tool (browser-tools audit 3b).
 *
 * agent-browser's `eval` serializes an un-invoked function expression to `{}`
 * and reports success — agents wrote `(() => {...})` without the trailing `()`
 * repeatedly and then misdiagnosed page state. Eval output is also unbounded
 * (`document.body.innerHTML` is a token bomb). These helpers auto-invoke bare
 * function expressions, cap output with an explicit notice, and attach hints
 * to the two most common eval error shapes.
 */

const MAX_EVAL_OUTPUT_CHARS = 8000

// Keywords that can only begin a STATEMENT (never a plain expression) — their
// presence at top level means the script is a statement body that must be
// wrapped. `await` is deliberately NOT here: it is an operator valid inside an
// expression, so it only flips hasAwait (handled with a value-preserving wrap).
const STATEMENT_KEYWORDS = new Set(['return', 'const', 'let', 'var', 'class', 'function', 'throw', 'if', 'for', 'while', 'switch', 'try'])

/**
 * Scan for statement-body markers that appear at bracket/quote depth 0:
 * a `return`/`const`/`let`/`var`/`class`/`function`/`await`/... keyword used
 * as a statement, or a `;` separating statements. Depth tracking is what keeps
 * an inner `return` (e.g. inside `.map(a => { return a.href })`) from being
 * mistaken for a top-level one — that script is a plain expression and must
 * pass through unwrapped to preserve its value.
 */
export function scanTopLevel(s: string): { isStatementBody: boolean; hasAwait: boolean } {
  let depth = 0
  let quote: string | null = null
  let hasStatementKeyword = false
  let hasTopLevelSemicolon = false
  let hasAwait = false
  let prevSignificant = '' // last non-space char seen, for member-access (.) checks

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    // comments
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (ch === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; prevSignificant = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; prevSignificant = ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; prevSignificant = ch; continue }

    if (depth === 0) {
      if (ch === ';') {
        if (s.slice(i + 1).trim() !== '') hasTopLevelSemicolon = true // more statements follow
        prevSignificant = ch
        continue
      }
      // identifier word starting here, not a member access (foo.return)
      if (/[A-Za-z_$]/.test(ch) && prevSignificant !== '.' && !/[\w$]/.test(s[i - 1] || '')) {
        let j = i
        while (j < s.length && /[\w$]/.test(s[j])) j++
        const word = s.slice(i, j)
        if (word === 'await') hasAwait = true
        else if (STATEMENT_KEYWORDS.has(word)) hasStatementKeyword = true
        i = j - 1
        prevSignificant = word[word.length - 1]
        continue
      }
    }
    if (!/\s/.test(ch)) prevSignificant = ch
  }

  return { isStatementBody: hasStatementKeyword || hasTopLevelSemicolon, hasAwait }
}

/**
 * Prepare a script for agent-browser's `eval`, which runs every script as a
 * statement list in ONE long-lived shared V8 realm. That means a top-level
 * `return` is illegal and a `const`/`let` collides with the same name from a
 * prior call ("already declared") — the most pervasive failure in the
 * browser-tools audit (13/47 transcripts). Wrapping a statement body in a
 * fresh async IIFE makes `return`/`await` legal and scopes declarations so
 * they can't collide. Plain expressions are left raw so their value is still
 * returned (wrapping `document.title` in a function body would yield
 * undefined); bare function literals are invoked as before.
 */
export function prepareEvalScript(raw: string): { script: string; wrapped: boolean } {
  const s = raw.trim().replace(/;+\s*$/, '')
  if (s === '') return { script: raw, wrapped: false }

  // A function literal, optionally parenthesized: (async) arrow with parened
  // or bare single param, or a function keyword expression.
  const isFunctionLiteral = /^\(?\s*(async\s+)?(\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\b)/.test(s)
  if (isFunctionLiteral) {
    // Already invoked: ends with `)(...)` (one nesting level of parens allowed
    // in the argument list). Mis-detection here fails loudly ("x is not a
    // function") rather than silently, and the wrapped flag is reported.
    const isInvoked = /\)\s*\((?:[^()]|\([^()]*\))*\)$/.test(s)
    if (isInvoked) return { script: raw, wrapped: false }
    return { script: `(${s})()`, wrapped: true }
  }

  const { isStatementBody, hasAwait } = scanTopLevel(s)
  if (isStatementBody) {
    // Statement body: fresh async scope makes return/await legal and isolates
    // declarations. Use `return` inside to produce a value.
    return { script: `(async () => {\n${s}\n})()`, wrapped: true }
  }
  if (hasAwait) {
    // Plain expression using top-level await — wrap so await is legal while
    // preserving the expression's value.
    return { script: `(async () => (${s}))()`, wrapped: true }
  }
  return { script: raw, wrapped: false }
}

/** Cap eval output, appending an actionable truncation notice. */
export function finalizeEvalOutput(output: string): string {
  if (output.length <= MAX_EVAL_OUTPUT_CHARS) return output
  return (
    output.slice(0, MAX_EVAL_OUTPUT_CHARS) +
    `\n…[truncated — result was ${output.length} chars. Narrow your selector or return JSON.stringify(...) of only the fields you need.]`
  )
}

/** Append a hint to known-confusing eval error shapes. */
export function evalErrorHint(error: string): string {
  if (/Cannot read propert(y|ies) of (null|undefined)/i.test(error)) {
    return `${error}\nHint: a selector likely matched nothing. eval runs in the TOP frame only — elements inside cross-origin iframes (e.g. payment frames) are unreachable from JavaScript; use coordinate clicks + browser_type for those.`
  }
  if (/is not a valid selector/i.test(error)) {
    return `${error}\nHint: attribute values containing spaces must be quoted inside the selector string, e.g. querySelector('iframe[title="Payment frame"]').`
  }
  return error
}
