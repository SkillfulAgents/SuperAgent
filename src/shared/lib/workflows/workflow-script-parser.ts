import type { ParsedAgentCall, ParsedScript, WorkflowPhase } from './workflow-schemas'

/**
 * Parse a persisted workflow script (the JS the `Workflow` tool generated) into
 * the structured `meta` + per-`agent()`-call data the tree builder needs to join
 * on-disk agent transcripts back to their label + phase.
 *
 * IMPORTANT: this is a *scanner*, not an evaluator. The script is model-authored
 * code; we never `eval` it and we don't depend on the TypeScript/Acorn parser
 * (host bundles via esbuild; pulling a full JS parser in is overkill). Instead we
 * walk the source with string/template/bracket awareness scoped to the narrow
 * grammar the Workflow tool emits:
 *   export const meta = { name, description, phases: [{title, detail}, ...] }
 *   phase('Title')
 *   parallel([ () => agent(prompt, opts), ... ])
 *   const x = await agent(prompt, { label, phase, ... })
 *
 * Each `agent()` prompt is converted to an anchored regex (with `${expr}` holes as
 * capture groups) so the resolved prompt in an agent transcript can be matched
 * back to its call site — exact-string matching breaks because interpolation is
 * already substituted on disk.
 */

const IDENT_RE = /[A-Za-z0-9_$]/

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_RE.test(ch)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Unescape the common backslash escapes found inside a string or template
 * literal so the literal text matches the resolved prompt seen in a transcript.
 */
function unescapeLiteral(inner: string): string {
  return inner.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'v':
        return '\v'
      case '0':
        return '\0'
      case 'u':
        return String.fromCodePoint(parseInt(esc.slice(1), 16))
      case 'x':
        return String.fromCodePoint(parseInt(esc.slice(1), 16))
      default:
        return esc // \\, \', \", \`, \$, \/, etc. → the literal char
    }
  })
}

/**
 * Given `src[i]` is an opening quote (`'`, `"`, or `` ` ``), return the index just
 * past the matching closing quote. Handles backslash escapes and, for template
 * literals, `${ ... }` interpolation whose body may itself contain strings/braces.
 */
function skipQuote(src: string, i: number): number {
  const q = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (q === '`' && c === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1, '{', '}')
      continue
    }
    if (c === q) return i + 1
    i++
  }
  return i
}

/**
 * Given `src[open]` is `openCh`, return the index just past the matching `closeCh`,
 * skipping nested strings/templates, comments, and nested same-type brackets.
 */
function skipBalanced(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuote(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === openCh) {
      depth++
      i++
      continue
    }
    if (c === closeCh) {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    i++
  }
  return i
}

/** Split an argument-list source on top-level commas (ignoring nested brackets/strings). */
function splitTopLevelArgs(src: string): string[] {
  const args: string[] = []
  let start = 0
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuote(src, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      i = skipBalanced(src, i, c, c === '(' ? ')' : c === '[' ? ']' : '}')
      continue
    }
    if (c === ',') {
      args.push(src.slice(start, i))
      start = i + 1
    }
    i++
  }
  const tail = src.slice(start)
  if (tail.trim().length > 0) args.push(tail)
  return args
}

/**
 * Parse a top-level object literal `{ ... }` into a map of key → raw value source.
 * Keys may be bare identifiers or quoted; values keep their original source text.
 */
function parseObjectFields(objSrc: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const trimmed = objSrc.trim()
  if (!trimmed.startsWith('{')) return fields
  const open = objSrc.indexOf('{')
  const close = skipBalanced(objSrc, open, '{', '}')
  const inner = objSrc.slice(open + 1, close - 1)
  for (const part of splitTopLevelArgs(inner)) {
    const seg = part.trim()
    if (!seg) continue
    // key: read a quoted or bare key, then the ':' separator.
    let key: string
    let rest: string
    if (seg[0] === '"' || seg[0] === "'" || seg[0] === '`') {
      const end = skipQuote(seg, 0)
      key = unescapeLiteral(seg.slice(1, end - 1))
      rest = seg.slice(end).replace(/^\s*:/, '')
    } else {
      const m = seg.match(/^([A-Za-z0-9_$]+)\s*:/)
      if (!m) continue // shorthand / spread / method — ignore
      key = m[1]
      rest = seg.slice(m[0].length)
    }
    fields[key] = rest.trim()
  }
  return fields
}

/** Read a string/template literal's inner content, or null if not a literal. */
function readLiteralInner(valSrc: string): string | null {
  const s = valSrc.trim()
  const q = s[0]
  if (q !== '"' && q !== "'" && q !== '`') return null
  const end = skipQuote(s, 0)
  return s.slice(1, end - 1)
}

/** Static string value (single/double-quoted, no interpolation), unescaped, or null. */
function readStaticString(valSrc: string | undefined): string | null {
  if (valSrc === undefined) return null
  const s = valSrc.trim()
  if (s[0] !== '"' && s[0] !== "'") return null
  const inner = readLiteralInner(s)
  return inner === null ? null : unescapeLiteral(inner)
}

/**
 * Convert a prompt argument (string OR template literal) into an anchored regex
 * plus the positional list of `${expr}` source texts.
 */
function parsePromptArg(argSrc: string): { promptRegexSource: string; holeExprs: string[] } {
  const s = argSrc.trim()
  const q = s[0]
  if (q === '"' || q === "'") {
    const inner = readLiteralInner(s) ?? ''
    return { promptRegexSource: '^' + escapeRegex(unescapeLiteral(inner)) + '$', holeExprs: [] }
  }
  if (q === '`') {
    const inner = readLiteralInner(s) ?? ''
    const { regexBody, holeExprs } = templateToRegex(inner)
    return { promptRegexSource: '^' + regexBody + '$', holeExprs }
  }
  // Non-literal prompt (a variable / call) — match anything; rely on ordinal fallback.
  return { promptRegexSource: '^[\\s\\S]*$', holeExprs: [] }
}

/**
 * Split a template-literal inner string into quasis + `${expr}` holes and build a
 * regex body: each quasi is unescaped then regex-escaped; each hole becomes a
 * non-greedy capture group.
 */
function templateToRegex(inner: string): { regexBody: string; holeExprs: string[] } {
  let body = ''
  const holeExprs: string[] = []
  let i = 0
  let quasi = ''
  while (i < inner.length) {
    const c = inner[i]
    if (c === '\\') {
      quasi += inner[i] + (inner[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === '$' && inner[i + 1] === '{') {
      body += escapeRegex(unescapeLiteral(quasi))
      quasi = ''
      const end = skipBalanced(inner, i + 1, '{', '}')
      holeExprs.push(inner.slice(i + 2, end - 1).trim())
      body += '([\\s\\S]*?)'
      i = end
      continue
    }
    quasi += c
    i++
  }
  body += escapeRegex(unescapeLiteral(quasi))
  return { regexBody: body, holeExprs }
}

/** Read `opts.label` keeping `${expr}` holes intact (for later capture substitution). */
function parseLabelTemplate(valSrc: string | undefined): string | null {
  if (valSrc === undefined) return null
  const inner = readLiteralInner(valSrc)
  if (inner === null) return null
  // For plain strings, unescape; for templates, keep `${...}` literal so the join
  // can substitute captured values. We detect a template by the presence of `${`.
  return inner.includes('${') ? inner : unescapeLiteral(inner)
}

/** Extract `meta.name`, `meta.description`, and `meta.phases` from the script. */
function extractMeta(src: string): {
  name: string | null
  description: string | null
  phases: WorkflowPhase[]
} {
  const m = src.match(/export\s+const\s+meta\s*=\s*\{/)
  if (!m || m.index === undefined) return { name: null, description: null, phases: [] }
  const open = src.indexOf('{', m.index)
  const close = skipBalanced(src, open, '{', '}')
  const fields = parseObjectFields(src.slice(open, close))
  const phases: WorkflowPhase[] = []
  if (fields.phases) {
    const arr = fields.phases.trim()
    const aOpen = arr.indexOf('[')
    if (aOpen >= 0) {
      const aClose = skipBalanced(arr, aOpen, '[', ']')
      for (const el of splitTopLevelArgs(arr.slice(aOpen + 1, aClose - 1))) {
        const ef = parseObjectFields(el)
        const title = readStaticString(ef.title) ?? readLiteralInner(ef.title ?? '')
        if (title) phases.push({ title, detail: readStaticString(ef.detail) ?? undefined })
      }
    }
  }
  return {
    name: readStaticString(fields.name),
    description: readStaticString(fields.description),
    phases,
  }
}

/** Does `src` have a call to `kw` starting at `i`? Returns the `(` index, or -1. */
function callParenAt(src: string, i: number, kw: string): number {
  if (isIdentChar(src[i - 1])) return -1
  if (!src.startsWith(kw, i)) return -1
  let j = i + kw.length
  while (j < src.length && /\s/.test(src[j])) j++
  return src[j] === '(' ? j : -1
}

export function parseWorkflowScript(src: string): ParsedScript {
  const { name, description, phases } = extractMeta(src)
  const agentCalls: ParsedAgentCall[] = []
  let currentSourcePhase: string | null = null
  let parallelEnd = -1
  let sourceIndex = 0

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuote(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }

    const phaseParen = callParenAt(src, i, 'phase')
    if (phaseParen >= 0) {
      const end = skipBalanced(src, phaseParen, '(', ')')
      const arg = src.slice(phaseParen + 1, end - 1)
      currentSourcePhase = readStaticString(arg) ?? readLiteralInner(arg.trim())
      i = end
      continue
    }

    const parallelParen = callParenAt(src, i, 'parallel')
    if (parallelParen >= 0) {
      parallelEnd = skipBalanced(src, parallelParen, '(', ')')
      i = parallelParen + 1 // walk INTO it so inner agent() calls are seen
      continue
    }

    const agentParen = callParenAt(src, i, 'agent')
    if (agentParen >= 0) {
      const end = skipBalanced(src, agentParen, '(', ')')
      const args = splitTopLevelArgs(src.slice(agentParen + 1, end - 1))
      const { promptRegexSource, holeExprs } = parsePromptArg(args[0] ?? '')
      const opts = args[1] ? parseObjectFields(args[1]) : {}
      agentCalls.push({
        promptRegexSource,
        holeExprs,
        labelTemplate: parseLabelTemplate(opts.label),
        phase: readStaticString(opts.phase),
        sourcePhase: currentSourcePhase,
        sourceIndex: sourceIndex++,
        inParallel: agentParen < parallelEnd,
      })
      i = end
      continue
    }

    i++
  }

  return { name, description, phases, agentCalls }
}
