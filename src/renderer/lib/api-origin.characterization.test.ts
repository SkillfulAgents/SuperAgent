/**
 * Characterization: where the renderer's network calls get their origin.
 *
 * The renderer reaches its API through exactly one origin, resolved by
 * `getApiBaseUrl()` (`lib/env.ts`) — empty in web mode (same-origin), and
 * `http://localhost:{port}` under Electron, where the port is assigned at
 * runtime. Almost everything goes through `apiFetch`, which prepends it; a
 * handful of call sites build URLs themselves because their consumer is not
 * `fetch` at all (an `<img src>`, an `EventSource`, a `WebSocket`, an Electron
 * `downloadURL`) and so cannot use the wrapper.
 *
 * That invariant is currently upheld by convention alone. Nothing fails if a
 * new call site hardcodes a same-origin `/api/...` path: it works in the
 * browser, it works in Electron dev, and it only breaks where the API is not
 * the origin the document was loaded from. So this suite pins the truth:
 *
 *   1. Every network primitive traces back to `getApiBaseUrl()` through its own
 *      file's declarations, or is pinned below by call site.
 *   2. None passes a hardcoded same-origin `/api` path.
 *   3. The set of modules that bypass `apiFetch` is an explicit inventory.
 *
 * This is characterization, not policy: it asserts what is true today so that
 * changing it is a deliberate edit to this file rather than a silent drift. If
 * you are here because the suite failed, the fix is usually to route the new
 * call through `apiFetch` — not to add a line to a list.
 *
 * The lists matter because the URL-composing sites are the ones that need
 * individual attention if the renderer is ever pointed at a non-local API:
 * `Authorization` headers cannot be attached to an `<img>`, an `EventSource`,
 * or a `WebSocket`.
 *
 * **Why the parser and not a regex.** Two things a text scan cannot do, both of
 * which let a real bypass through: recognize `window.fetch(...)` and
 * `globalThis.fetch(...)` as the same primitive as `fetch(...)`, and tell
 * `const baseUrl = getApiBaseUrl()` from `const baseUrl = window.location.origin`
 * — a name proves nothing about provenance. So call sites are found in the AST,
 * and each URL expression is resolved through the enclosing scope's
 * declarations until it either reaches `getApiBaseUrl()` or runs out. The
 * `scanner` suite at the bottom asserts both of those directly.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const RENDERER_ROOT = path.resolve(__dirname, '..')

/** Receivers for which `X.fetch(...)` is the global `fetch`. */
const GLOBAL_RECEIVERS = new Set(['window', 'globalThis', 'self', 'global'])

const PRIMITIVE_CONSTRUCTORS = new Set(['EventSource', 'WebSocket'])

/**
 * Individual call sites whose URL cannot be traced to `getApiBaseUrl()` within
 * their own file, and where it actually comes from. Keyed by call site rather
 * than by module: trusting a whole module would silently bless the *next* call
 * added to it, which is the kind of drift this suite exists to catch.
 *
 * The key embeds the first-argument text, so changing what a pinned call passes
 * re-opens it for review instead of riding on the old exemption.
 */
const PINNED_CALL_SITES: Record<string, string> = {
  'components/file-preview/renderers/use-file-content.ts::fetch(url)':
    'prebuilt `url` prop; composed by file-preview-tray-content.tsx from getApiBaseUrl()',
  'components/file-preview/renderers/audio-renderer.tsx::fetch(url)':
    'prebuilt `url` prop; same origin as use-file-content.ts above',
  'lib/stt.ts::WebSocket(url)':
    'third-party STT provider, not this API — must NOT follow the API origin',
  'lib/voice-agent-deepgram.ts::WebSocket(url)':
    'third-party Deepgram socket — must NOT follow the API origin',
  'lib/voice-agent-openai.ts::WebSocket(url)':
    'third-party OpenAI realtime socket — must NOT follow the API origin',
}

/**
 * Third-party endpoints: realtime voice/STT sockets opened straight from the
 * renderer to the provider, authenticated with a short-lived token the API
 * mints. They are not this app's API and must not follow its origin.
 */
const EXTERNAL_ENDPOINT_MODULES = [
  'lib/stt.ts',
  'lib/voice-agent-deepgram.ts',
  'lib/voice-agent-openai.ts',
]

/**
 * Modules that call `getApiBaseUrl()` directly instead of going through
 * `apiFetch`, and why the wrapper does not fit. Every entry is a URL handed to
 * something that cannot carry a request header.
 *
 * Growing this list is a real cost: each entry has to be revisited by hand
 * whenever the API origin changes.
 */
const DIRECT_BASE_URL_CONSUMERS: Record<string, string> = {
  'lib/api.ts': 'the wrapper itself',
  'lib/env.ts': 'defines it; openDashboardExternal() builds a window.open() URL',
  'components/ui/model-icon.tsx': '<img src> — model icon asset',
  'components/home/dashboard-card.tsx': '<img src> — dashboard screenshot',
  'components/dashboards/dashboard-view.tsx': '<iframe src> — embedded dashboard',
  'components/file-preview/file-preview-tray-content.tsx': 'file URL passed to previewers/<img>',
  'components/file-preview/renderers/unsupported-renderer.tsx': 'download link href',
  'components/messages/message-input.tsx': 'fire-and-forget typing ping (deliberately not awaited)',
  'components/notifications/global-notification-handler.tsx':
    'EventSource — global notification stream',
  'hooks/use-message-stream.ts': 'EventSource — per-session message stream',
  'hooks/use-browser-stream.ts': 'WebSocket — browser view frames',
}

// ---------------------------------------------------------------------------
// AST scanning
// ---------------------------------------------------------------------------

interface CallSite {
  /** Renderer-relative module path. */
  file: string
  line: number
  primitive: string
  /** Source text of the first argument, or '' when called with none. */
  argument: string
  /** `file::primitive(argument)` — the pinning key. */
  key: string
  /** The first argument as a plain string literal, when it is one. */
  literal: string | null
  tracesToApiBaseUrl: boolean
}

function parseSource(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/** The primitive this node invokes, or null if it is not a network call. */
function primitiveOf(node: ts.Node): string | null {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (ts.isIdentifier(callee)) return callee.text === 'fetch' ? 'fetch' : null

    // `window.fetch(...)`, `globalThis.fetch(...)`, `self['fetch'](...)`.
    const receiver =
      ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? callee.expression
        : null
    if (!receiver || !ts.isIdentifier(receiver) || !GLOBAL_RECEIVERS.has(receiver.text)) return null
    const member = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
        ? callee.argumentExpression.text
        : null
    return member === 'fetch' ? 'fetch' : null
  }

  if (ts.isNewExpression(node)) {
    const callee = node.expression
    if (ts.isIdentifier(callee) && PRIMITIVE_CONSTRUCTORS.has(callee.text)) return callee.text
    // `new window.EventSource(...)`
    if (ts.isPropertyAccessExpression(callee) && PRIMITIVE_CONSTRUCTORS.has(callee.name.text)) {
      const receiver = callee.expression
      if (ts.isIdentifier(receiver) && GLOBAL_RECEIVERS.has(receiver.text)) return callee.name.text
    }
  }
  return null
}

/**
 * The initializer of the nearest lexically enclosing `const/let X = …`, walking
 * outward from `from`. Approximate scope resolution — enough to prefer a local
 * `baseUrl` over an outer one, which is the case that matters, without standing
 * up a full TypeChecker.
 */
function findDeclarationInScope(name: string, from: ts.Node): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined
    if (!statements) continue

    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          return declaration.initializer
        }
      }
    }
  }
  return undefined
}

/**
 * Whether `expr` actually derives from `getApiBaseUrl()`, following identifiers
 * through their declarations. This is the check a name test cannot make:
 * `const baseUrl = window.location.origin` reaches nothing and fails here.
 */
function tracesToApiBaseUrl(expr: ts.Node, origin: ts.Node, seen = new Set<string>()): boolean {
  if (seen.size > 12) return false // pathological chains: give up rather than hang
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'getApiBaseUrl'
    ) {
      found = true
      return
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const initializer = findDeclarationInScope(node.text, origin)
      if (initializer) {
        seen.add(node.text)
        if (tracesToApiBaseUrl(initializer, origin, seen)) {
          found = true
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(expr)
  return found
}

/** Every network primitive call in one module. */
function scanSource(relativePath: string, text: string): CallSite[] {
  const sourceFile = parseSource(relativePath, text)
  const sites: CallSite[] = []

  const visit = (node: ts.Node): void => {
    const primitive = primitiveOf(node)
    if (primitive) {
      const first = (node as ts.CallExpression | ts.NewExpression).arguments?.[0]
      const argument = first ? first.getText(sourceFile) : ''
      sites.push({
        file: relativePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        primitive,
        argument,
        key: `${relativePath}::${primitive}(${argument})`,
        literal: first && ts.isStringLiteralLike(first) ? first.text : null,
        tracesToApiBaseUrl: first ? tracesToApiBaseUrl(first, first) : false,
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return sites
}

/** Recursively collect renderer sources, skipping tests and test helpers. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'public') continue
      collectSourceFiles(full, acc)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    acc.push(full)
  }
  return acc
}

function relativeTo(file: string): string {
  return path.relative(RENDERER_ROOT, file).split(path.sep).join('/')
}

function allCallSites(): CallSite[] {
  return collectSourceFiles(RENDERER_ROOT).flatMap((file) =>
    scanSource(relativeTo(file), fs.readFileSync(file, 'utf-8')),
  )
}

/** Modules that reference `getApiBaseUrl` as a value. */
function directBaseUrlConsumers(): string[] {
  return collectSourceFiles(RENDERER_ROOT)
    .filter((file) => {
      const sourceFile = parseSource(relativeTo(file), fs.readFileSync(file, 'utf-8'))
      let uses = false
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'getApiBaseUrl') uses = true
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
      return uses
    })
    .map(relativeTo)
    .sort()
}

// ---------------------------------------------------------------------------

describe('renderer API origin', () => {
  it('traces every network primitive back to getApiBaseUrl()', () => {
    const unaccounted = allCallSites().filter(
      (site) => !site.tracesToApiBaseUrl && !(site.key in PINNED_CALL_SITES),
    )

    expect(unaccounted.map((s) => `${s.file}:${s.line} ${s.primitive}(${s.argument})`)).toEqual([])
  })

  it('never hardcodes a same-origin /api path into a network primitive', () => {
    // The failure this catches: `fetch('/api/agents')` works in the browser and
    // in Electron dev, and silently talks to the wrong server anywhere the API
    // is not the document's origin.
    const sameOrigin = allCallSites().filter((site) => site.literal?.startsWith('/api'))

    expect(sameOrigin.map((s) => `${s.file}:${s.line} ${s.primitive}`)).toEqual([])
  })

  it('pins the set of modules that compose API URLs without apiFetch', () => {
    // Sorted comparison so a failure names the file that appeared or vanished.
    expect(directBaseUrlConsumers()).toEqual(Object.keys(DIRECT_BASE_URL_CONSUMERS).sort())
  })

  it('documents why each pinned entry is pinned', () => {
    // Guards both lists against becoming bare sets of paths: an entry without a
    // reason is an entry nobody can evaluate later.
    const pinned = { ...DIRECT_BASE_URL_CONSUMERS, ...PINNED_CALL_SITES }
    for (const [key, reason] of Object.entries(pinned)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(10)
    }
  })

  it('keeps third-party realtime sockets independent of the API origin', () => {
    // If one of these ever started deriving its URL from getApiBaseUrl(), it
    // would follow the API origin — and break, since the provider is not this
    // app. Asserted from the parsed source, not a text match.
    for (const module of EXTERNAL_ENDPOINT_MODULES) {
      const sites = scanSource(module, fs.readFileSync(path.join(RENDERER_ROOT, module), 'utf-8'))
      expect(sites.length, `${module} should still open a socket`).toBeGreaterThan(0)
      for (const site of sites) {
        expect(
          site.tracesToApiBaseUrl,
          `${module}:${site.line} must not follow the API origin`,
        ).toBe(false)
      }
    }
  })
})

/**
 * The scanner's own behaviour, on synthetic sources. These are the claims the
 * suite above rests on, and several are cases a text scan gets wrong — so they
 * are asserted directly rather than left to hold by inspection.
 */
describe('scanner', () => {
  const scan = (code: string) => scanSource('probe.ts', code)

  it.each([
    ['bare', `fetch('/api/agents')`],
    ['window member', `window.fetch('/api/agents')`],
    ['globalThis member', `globalThis.fetch('/api/agents')`],
    ['self member', `self.fetch('/api/agents')`],
    ['element access', `window['fetch']('/api/agents')`],
  ])('recognizes a %s fetch call', (_label, code) => {
    const [site] = scan(code)
    expect(site?.primitive).toBe('fetch')
    expect(site?.literal).toBe('/api/agents')
  })

  it.each([
    ['EventSource', `new EventSource(u)`],
    ['WebSocket', `new WebSocket(u)`],
    ['namespaced EventSource', `new window.EventSource(u)`],
  ])('recognizes %s construction', (_label, code) => {
    expect(scan(code)[0]?.primitive).toMatch(/EventSource|WebSocket/)
  })

  it('does not mistake apiFetch or an unrelated member for a primitive', () => {
    expect(scan(`apiFetch('/api/agents')`)).toHaveLength(0)
    expect(scan(`queryClient.fetch('/api/agents')`)).toHaveLength(0)
    expect(scan(`mcpSafeFetch('/api/agents')`)).toHaveLength(0)
  })

  it('ignores calls that only appear in comments or strings', () => {
    // The parser gives this for free; the earlier text scanner needed a
    // hand-rolled masking pass and still tripped on a settings string reading
    // "use fetch (search still works)".
    expect(scan(`// fetch('/api/agents')`)).toHaveLength(0)
    expect(scan(`const help = "call fetch('/api/agents') to load them"`)).toHaveLength(0)
  })

  it('traces a URL through local declarations to getApiBaseUrl()', () => {
    const [site] = scan(`
      function load() {
        const baseUrl = getApiBaseUrl()
        const url = \`\${baseUrl}/api/agents\`
        return fetch(url)
      }
    `)
    expect(site.tracesToApiBaseUrl).toBe(true)
  })

  it('rejects an identifier that merely happens to be named baseUrl', () => {
    // The point of resolving provenance: the name proves nothing.
    const [site] = scan(`
      function load() {
        const baseUrl = window.location.origin
        return fetch(\`\${baseUrl}/api/agents\`)
      }
    `)
    expect(site.tracesToApiBaseUrl).toBe(false)
  })

  it('rejects a URL that arrives as a parameter', () => {
    const [site] = scan(`function load(url: string) { return fetch(url) }`)
    expect(site.tracesToApiBaseUrl).toBe(false)
  })

  it('prefers the nearest declaration when a name is shadowed', () => {
    const sites = scan(`
      const baseUrl = getApiBaseUrl()
      function outer() { return fetch(\`\${baseUrl}/api/a\`) }
      function inner() {
        const baseUrl = window.location.origin
        return fetch(\`\${baseUrl}/api/b\`)
      }
    `)
    expect(sites.map((s) => s.tracesToApiBaseUrl)).toEqual([true, false])
  })
})
