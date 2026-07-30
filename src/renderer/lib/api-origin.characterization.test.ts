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
 *   1. Every network primitive takes its origin from `getApiBaseUrl()` on
 *      *every* branch, or is pinned below by exact call site.
 *   2. None can lead with a hardcoded same-origin `/api` path, on any branch.
 *   3. Each pin matches exactly one real call — no shared pins, no stale ones.
 *   4. The set of modules that bypass `apiFetch` is an explicit inventory.
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
 * **Why the parser and not a regex.** A text scan cannot recognize
 * `window.fetch(...)` as the same primitive as `fetch(...)`, and cannot tell
 * `const baseUrl = getApiBaseUrl()` from `const baseUrl = window.location.origin`
 * — a name proves nothing about provenance. So call sites come from the AST and
 * each URL expression is resolved through its enclosing scope's declarations.
 *
 * **Why per branch.** Containment is not derivation. `getApiBaseUrl()` appears
 * in `flag ? getApiBaseUrl() + '/api/x' : '/api/x'`, which is same-origin half
 * the time — so a conditional derives only when *both* arms do, `??`/`||`
 * fallbacks count as branches, and only the leading position of a template or
 * concatenation decides the origin at all.
 *
 * **Why transforms are opaque.** Deriving *from* the base URL is not the same
 * as keeping it. `replace`, `slice`, and `substring` can each strip the scheme
 * and host — `base.replace('https://api.example.com', '')` is a same-origin
 * path with impeccable provenance — so no method call is treated as
 * origin-preserving. The one place that legitimately rewrites the scheme is
 * pinned and explained instead.
 *
 * **Why lookups follow the initializer.** Resolving an identifier continues
 * from where it was declared, not from the call site. Otherwise a block that
 * shadows `baseUrl` with `getApiBaseUrl()` retroactively validates an outer
 * `url` that was built before that declaration existed.
 *
 * The `scanner` suite at the bottom asserts each of these directly, on
 * synthetic sources, so they do not rest on inspection of the real tree.
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
 * Individual call sites whose URL the analysis below cannot resolve to
 * `getApiBaseUrl()`, and where it actually comes from.
 *
 * Keyed `file::scope::primitive(argument)`. Every part is load-bearing:
 * per-module keys would bless the *next* call added to the module, and the
 * enclosing scope is what separates the two `createSocket` methods in
 * `lib/stt.ts`, which are otherwise identical calls. The argument text is
 * included so changing what a pinned call passes re-opens it for review rather
 * than riding on the old exemption.
 *
 * Every key must match exactly one real call — asserted below, so a pin cannot
 * cover two sites at once or quietly outlive the call it was written for.
 */
const PINNED_CALL_SITES: Record<string, string> = {
  'components/file-preview/renderers/use-file-content.ts::useFileContent::fetch(url)':
    'prebuilt `url` prop; composed by file-preview-tray-content.tsx from getApiBaseUrl()',
  'components/file-preview/renderers/audio-renderer.tsx::AudioRenderer.decodeWaveform::fetch(url)':
    'prebuilt `url` prop; same origin as use-file-content.ts above',
  // Not third-party — this one IS our API, reached over ws:// instead of http://.
  'hooks/use-browser-stream.ts::useBrowserStream::WebSocket(wsUrl)':
    'the only site that does scheme surgery: it splits getApiBaseUrl() into a ' +
    "literal 'ws'/'wss' scheme and a host, so no single leading expression " +
    'derives the origin even though the host does. The `window.location.host` ' +
    'fallback is correct — getApiBaseUrl() is empty in web mode, where ' +
    'same-origin is the right answer. Re-read this if the API origin ever moves.',
  'lib/stt.ts::DeepgramAdapter.createSocket::WebSocket(url)':
    'third-party Deepgram STT endpoint, not this API — must NOT follow the API origin',
  'lib/stt.ts::OpenaiAdapter.createSocket::WebSocket(url)':
    'third-party OpenAI STT endpoint, not this API — must NOT follow the API origin',
  'lib/voice-agent-deepgram.ts::DeepgramVoiceAgentAdapter.connect::WebSocket(url)':
    'third-party Deepgram voice-agent socket — must NOT follow the API origin',
  'lib/voice-agent-openai.ts::OpenAIVoiceAgentAdapter.connect::WebSocket(url)':
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
  /** Dotted enclosing class/function path, e.g. `DeepgramAdapter.createSocket`. */
  scope: string
  /** `file::scope::primitive(argument)` — the pinning key. */
  key: string
  /** String literals that could stand at the front of the URL, across all branches. */
  originLiterals: string[]
  /** True only when every branch takes its origin from `getApiBaseUrl()`. */
  derivesOrigin: boolean
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

interface OriginAnalysis {
  /** True only when EVERY path this expression can take derives from the base URL. */
  derives: boolean
  /** String literals that could stand at the front of the URL, across all paths. */
  literals: string[]
}

const NOTHING: OriginAnalysis = { derives: false, literals: [] }

/**
 * What determines the origin of a URL expression, examined per branch.
 *
 * A containment test ("does `getApiBaseUrl` appear anywhere in here") is not
 * enough: `flag ? getApiBaseUrl() + '/api/x' : '/api/x'` contains it and is
 * still same-origin half the time. So a conditional derives only when *both*
 * arms do, and the literals from both arms are reported together.
 *
 * Only the leading position matters. `` `${base}/api/x` `` takes its origin
 * from `base`; `` `/api/${id}` `` is same-origin no matter what `id` holds.
 */
function analyzeOrigin(node: ts.Node, from: ts.Node, seen = new Set<string>()): OriginAnalysis {
  if (seen.size > 12) return NOTHING // pathological chains: give up rather than hang

  if (ts.isParenthesizedExpression(node)) return analyzeOrigin(node.expression, from, seen)

  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === 'getApiBaseUrl') {
      return { derives: true, literals: [] }
    }
    // Any other call — including a method on a derived receiver — is opaque.
    // `replace`, `slice`, and `substring` can all strip or rewrite the scheme
    // and host, so `base.replace('https://api.example.com', '')` yields a
    // same-origin path while still "coming from" the base URL. A transform
    // that genuinely preserves the origin has to be pinned and read, not
    // inferred from the receiver.
    return NOTHING
  }

  // Every arm must derive; every arm's literals count.
  if (ts.isConditionalExpression(node)) {
    const a = analyzeOrigin(node.whenTrue, from, seen)
    const b = analyzeOrigin(node.whenFalse, from, seen)
    return { derives: a.derives && b.derives, literals: [...a.literals, ...b.literals] }
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    // Concatenation: the left operand fixes the origin.
    if (op === ts.SyntaxKind.PlusToken) return analyzeOrigin(node.left, from, seen)
    // Fallbacks are branches like a conditional.
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      const a = analyzeOrigin(node.left, from, seen)
      const b = analyzeOrigin(node.right, from, seen)
      return { derives: a.derives && b.derives, literals: [...a.literals, ...b.literals] }
    }
    return NOTHING
  }

  if (ts.isTemplateExpression(node)) {
    // A non-empty head means a literal leads, whatever follows.
    if (node.head.text.length > 0) return { derives: false, literals: [node.head.text] }
    const first = node.templateSpans[0]
    return first ? analyzeOrigin(first.expression, from, seen) : NOTHING
  }

  if (ts.isStringLiteralLike(node)) return { derives: false, literals: [node.text] }

  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return NOTHING
    const initializer = findDeclarationInScope(node.text, from)
    if (!initializer) return NOTHING
    // Continue from the initializer, not the original call site: names inside
    // it must resolve where it was written. Keeping the call site as the
    // lookup origin lets an inner block that shadows `baseUrl` with
    // `getApiBaseUrl()` retroactively validate an outer `url` that never saw
    // that declaration.
    return analyzeOrigin(initializer, initializer, new Set([...seen, node.text]))
  }

  return NOTHING
}

/**
 * Dotted path of the enclosing class/function names, e.g.
 * `DeepgramAdapter.createSocket`. Line numbers would churn on every edit above
 * a call; the method name alone is not unique either — `stt.ts` has two
 * `createSocket` methods, one per adapter class.
 */
function enclosingScopePath(node: ts.Node): string {
  const names: string[] = []
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
    if (
      (ts.isClassDeclaration(cursor) ||
        ts.isFunctionDeclaration(cursor) ||
        ts.isMethodDeclaration(cursor)) &&
      cursor.name &&
      ts.isIdentifier(cursor.name)
    ) {
      names.push(cursor.name.text)
    } else if (
      ts.isVariableDeclaration(cursor) &&
      ts.isIdentifier(cursor.name) &&
      cursor.initializer &&
      (ts.isArrowFunction(cursor.initializer) || ts.isFunctionExpression(cursor.initializer))
    ) {
      names.push(cursor.name.text)
    }
  }
  return names.reverse().join('.') || 'module'
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
      const scope = enclosingScopePath(node)
      const origin = first ? analyzeOrigin(first, first) : NOTHING
      sites.push({
        file: relativePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        primitive,
        argument,
        scope,
        key: `${relativePath}::${scope}::${primitive}(${argument})`,
        originLiterals: origin.literals,
        derivesOrigin: origin.derives,
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
      (site) => !site.derivesOrigin && !(site.key in PINNED_CALL_SITES),
    )

    expect(unaccounted.map((s) => `${s.file}:${s.line} ${s.scope} ${s.primitive}(${s.argument})`))
      .toEqual([])
  })

  it('never hardcodes a same-origin /api path into a network primitive', () => {
    // The failure this catches: `fetch('/api/agents')` works in the browser and
    // in Electron dev, and silently talks to the wrong server anywhere the API
    // is not the document's origin. Checked across every branch, so a
    // conditional with one same-origin arm is caught too.
    const sameOrigin = allCallSites().filter((site) =>
      site.originLiterals.some((literal) => literal.startsWith('/api')),
    )

    expect(sameOrigin.map((s) => `${s.file}:${s.line} ${s.primitive}`)).toEqual([])
  })

  it('matches every pinned call site to exactly one real call', () => {
    // Pins are exemptions, so they have to name one call and keep naming it. A
    // key that matches two calls exempts both (and every future twin); a key
    // that matches none is a stale exemption nobody will notice has expired.
    const counts = new Map<string, number>()
    for (const site of allCallSites()) {
      counts.set(site.key, (counts.get(site.key) ?? 0) + 1)
    }

    const mismatched = Object.keys(PINNED_CALL_SITES)
      .map((key) => ({ key, matches: counts.get(key) ?? 0 }))
      .filter(({ matches }) => matches !== 1)

    expect(mismatched).toEqual([])
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
          site.derivesOrigin,
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
    expect(site?.originLiterals).toEqual(['/api/agents'])
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
    expect(site.derivesOrigin).toBe(true)
  })

  it('rejects an identifier that merely happens to be named baseUrl', () => {
    // The point of resolving provenance: the name proves nothing.
    const [site] = scan(`
      function load() {
        const baseUrl = window.location.origin
        return fetch(\`\${baseUrl}/api/agents\`)
      }
    `)
    expect(site.derivesOrigin).toBe(false)
  })

  it('rejects a URL that arrives as a parameter', () => {
    const [site] = scan(`function load(url: string) { return fetch(url) }`)
    expect(site.derivesOrigin).toBe(false)
  })

  it('rejects a conditional where only one arm uses the base URL', () => {
    // Containment is not derivation. This expression mentions getApiBaseUrl()
    // and is still same-origin half the time.
    const [site] = scan(`
      function load(flag: boolean) {
        return fetch(flag ? getApiBaseUrl() + '/api/agents' : '/api/agents')
      }
    `)
    expect(site.derivesOrigin).toBe(false)
    // And the same-origin arm's literal is still surfaced, so the more
    // specific assertion catches it too rather than only the general one.
    expect(site.originLiterals).toContain('/api/agents')
  })

  it('accepts a conditional where every arm uses the base URL', () => {
    const [site] = scan(`
      function load(flag: boolean) {
        const base = getApiBaseUrl()
        return fetch(flag ? \`\${base}/api/a\` : \`\${base}/api/b\`)
      }
    `)
    expect(site.derivesOrigin).toBe(true)
  })

  it('rejects a same-origin fallback behind ?? or ||', () => {
    // `base || '/api/x'` reads as a harmless default and is a same-origin
    // request whenever base is empty — which is exactly what web mode does.
    const [a] = scan(`function f() { const base = getApiBaseUrl(); return fetch(base ?? '/api/x') }`)
    const [b] = scan(`function f() { const base = getApiBaseUrl(); return fetch(base || '/api/x') }`)
    expect([a.derivesOrigin, b.derivesOrigin]).toEqual([false, false])
  })

  it('rejects a template whose literal leads', () => {
    // `/api/${id}` is same-origin no matter what `id` holds.
    const [site] = scan(`function f(id: string) { return fetch(\`/api/agents/\${id}\`) }`)
    expect(site.derivesOrigin).toBe(false)
    expect(site.originLiterals).toContain('/api/agents/')
  })

  it('rejects a string transform of the base URL', () => {
    // A method call is opaque, however derived its receiver. `replace`,
    // `slice`, and `substring` can each strip the scheme and host outright:
    // `base.replace('https://api.example.com', '')` produces a same-origin
    // path that still "comes from" the base URL. use-browser-stream does swap
    // http:// for ws:// this way, and is pinned and explained rather than
    // inferred.
    const [site] = scan(`
      function f() {
        const base = getApiBaseUrl()
        const host = base.replace(/^https?:\\/\\//, '')
        return fetch(host)
      }
    `)
    expect(site.derivesOrigin).toBe(false)
  })

  it('rejects a transform that strips the origin outright', () => {
    const [site] = scan(`
      function f() {
        const base = getApiBaseUrl()
        return fetch(base.replace('https://api.example.com', '') + '/api/x')
      }
    `)
    expect(site.derivesOrigin).toBe(false)
  })

  it('resolves an initializer from its own scope, not the call site', () => {
    // `url` is built where `baseUrl` is same-origin. An inner block that
    // shadows `baseUrl` with getApiBaseUrl() must not retroactively validate
    // it — the initializer never saw that declaration.
    const [site] = scan(`
      const baseUrl = window.location.origin
      const url = \`\${baseUrl}/api/agents\`
      function load() {
        const baseUrl = getApiBaseUrl()
        void baseUrl
        return fetch(url)
      }
    `)
    expect(site.derivesOrigin).toBe(false)
  })

  it('still resolves a chain declared alongside the call', () => {
    // The ordinary shape — global-notification-handler.tsx does exactly this.
    const [site] = scan(`
      function load() {
        const baseUrl = getApiBaseUrl()
        const url = \`\${baseUrl}/api/notifications/stream\`
        return fetch(url)
      }
    `)
    expect(site.derivesOrigin).toBe(true)
  })

  it('gives two identical calls in one file distinct identities', () => {
    // lib/stt.ts really does have two `new WebSocket(url, …)` calls, one per
    // adapter class. A key without the enclosing scope would cover both, so
    // one pin would exempt the other for free.
    const sites = scan(`
      class A { createSocket() { const url = 'wss://a'; return new WebSocket(url) } }
      class B { createSocket() { const url = 'wss://b'; return new WebSocket(url) } }
    `)
    expect(sites.map((s) => s.scope)).toEqual(['A.createSocket', 'B.createSocket'])
    expect(new Set(sites.map((s) => s.key)).size).toBe(2)
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
    expect(sites.map((s) => s.derivesOrigin)).toEqual([true, false])
  })
})
