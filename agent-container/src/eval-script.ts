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

/**
 * If the script is a bare (un-invoked) function expression, wrap it in an
 * IIFE so it actually runs. Already-invoked and non-function expressions pass
 * through untouched.
 */
export function prepareEvalScript(raw: string): { script: string; wrapped: boolean } {
  const s = raw.trim().replace(/;+\s*$/, '')

  // A function literal, optionally parenthesized: (async) arrow with parened
  // or bare single param, or a function keyword expression.
  const isFunctionLiteral = /^\(?\s*(async\s+)?(\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\b)/.test(s)
  if (!isFunctionLiteral) return { script: raw, wrapped: false }

  // Already invoked: ends with `)(...)` (one nesting level of parens allowed
  // in the argument list). Mis-detection here fails loudly ("x is not a
  // function") rather than silently, and the wrapped flag is reported.
  const isInvoked = /\)\s*\((?:[^()]|\([^()]*\))*\)$/.test(s)
  if (isInvoked) return { script: raw, wrapped: false }

  return { script: `(${s})()`, wrapped: true }
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
