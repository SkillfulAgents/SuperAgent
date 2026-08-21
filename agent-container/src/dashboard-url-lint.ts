import * as fs from 'fs'
import * as path from 'path'

export interface UrlLintFinding {
  /** Path relative to the dashboard directory, e.g. "index.js" or "src/app.js". */
  file: string
  /** 1-based line number. */
  line: number
  /** 1-based column of the match start. */
  column?: number
  /** Which matcher fired: "network-call" | "attribute" | "css-url". */
  kind: string
  /** The trimmed source line, for context in the warning. */
  snippet: string
}

// Only inspect *consumption* sites - the places a leading-slash path is actually
// requested by the browser. Server-side route declarations
// (`url.pathname === '/api/data'`, `app.get('/api/data')`) are deliberately NOT
// in these patterns, so correct server code is never flagged. Each pattern also
// excludes `//` (protocol-relative) and anything with a scheme (`https://`,
// `data:`) because those don't start with a single leading slash.
//
// This is a deliberately lightweight lexical scan, not a parser. Known, accepted
// limitations: it can flag a matching string sitting inside a comment or string
// literal; it treats a bare `src`/`href` assignment (e.g. `el.src = '/x'`) like
// an attribute (usually a real bug anyway); it misses calls split across multiple
// lines and uppercase CSS `URL(` (network/CSS forms stay case-sensitive so
// `new URL('/x')` and `FETCH` are never mistaken for matches); symlinked source
// files are skipped. The goal is to catch the common literal mistake cheaply.
const MATCHERS: { kind: string; re: RegExp }[] = [
  // fetch('/...'), axios('/...'), axios.get('/...'), new EventSource('/...').
  // Case-sensitive on purpose: JS identifiers are (FETCH is not a real call).
  {
    kind: 'network-call',
    re: /\b(?:fetch|EventSource|axios(?:\.(?:get|post|put|patch|delete|head|request))?)\s*\(\s*['"`]\/(?!\/)/g,
  },
  // <img src="/...">, <link href="/...">, <a href='/...'>. Case-insensitive:
  // HTML attribute names are.
  { kind: 'attribute', re: /\b(?:src|href)\s*=\s*['"]\/(?!\/)/gi },
  // CSS url(/...), url('/...'), @font-face { src: url("/...") }. The lookbehind
  // stops it firing inside identifiers like `curl(`. Case-sensitive to avoid
  // matching the JS `new URL('/x')` constructor.
  { kind: 'css-url', re: /(?<![\w-])url\(\s*['"]?\/(?!\/)/g },
]

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.html',
  '.htm',
  '.css',
])

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

const MAX_LISTED = 20

/** Scan a single source string. Pure - this is the precision contract. */
export function lintDashboardSource(source: string, file: string): UrlLintFinding[] {
  const findings: UrlLintFinding[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const m of MATCHERS) {
      // matchAll (regexes are /g) so every site on a line is counted, not just
      // the first - the warning's "(N)" must reflect the real total.
      for (const hit of line.matchAll(m.re)) {
        findings.push({
          file,
          line: i + 1,
          column: (hit.index ?? 0) + 1,
          kind: m.kind,
          snippet: line.trim().slice(0, 160),
        })
      }
    }
  }
  return findings
}

/** Recursively scan a dashboard directory's source files. Best-effort: unreadable entries are skipped. */
export function lintDashboardDir(dir: string): UrlLintFinding[] {
  const findings: UrlLintFinding[] = []
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        let content: string
        try {
          content = fs.readFileSync(full, 'utf8')
        } catch {
          continue
        }
        findings.push(...lintDashboardSource(content, path.relative(dir, full)))
      }
    }
  }
  walk(dir)
  return findings
}

/** Render findings into the warning block prepended to the start_dashboard response. */
export function formatUrlFindings(findings: UrlLintFinding[]): string {
  const shown = findings.slice(0, MAX_LISTED)
  const bullets = shown.map((f) => `  - ${f.file}:${f.line}  ${f.snippet}`).join('\n')
  const more =
    findings.length > shown.length ? `\n  ...and ${findings.length - shown.length} more` : ''
  return (
    `⚠ ABSOLUTE URLS DETECTED (${findings.length}) - these will 404 once the dashboard is ` +
    `served under its /api/agents/.../artifacts/<slug>/ subpath. Make each one relative (drop the ` +
    `leading slash, e.g. fetch('/api/x') -> fetch('api/x')) and call start_dashboard again:\n\n` +
    bullets +
    more +
    `\n\nServer-side route declarations (e.g. url.pathname === '/api/data') are correct and ` +
    `intentionally not listed.`
  )
}
