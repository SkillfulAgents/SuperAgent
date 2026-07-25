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
 *   1. Every network primitive in the renderer resolves its origin through
 *      `getApiBaseUrl()`, or is pinned below with a reason.
 *   2. The set of modules that bypass `apiFetch` and compose URLs themselves is
 *      an explicit inventory — small, and expensive to grow.
 *
 * This is characterization, not policy: it asserts what is true today so that
 * changing it is a deliberate edit to this file rather than a silent drift. If
 * you are here because the suite failed, the fix is usually to route the new
 * call through `apiFetch` — not to add a line to a list.
 *
 * Both lists exist because the URL-composing sites are the ones that need
 * individual attention if the renderer is ever pointed at a non-local API:
 * `Authorization` headers cannot be attached to an `<img>`, an `EventSource`,
 * or a `WebSocket`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RENDERER_ROOT = path.resolve(__dirname, '..')

/**
 * Call sites whose first argument arrives from elsewhere (a prop, a URL built
 * by a caller) rather than from a literal this scanner can resolve. Each is
 * listed with where its URL actually comes from, so the claim is checkable by
 * reading rather than by trusting the list.
 */
const UNRESOLVABLE_ARGUMENT_SITES: Record<string, string> = {
  'components/file-preview/renderers/use-file-content.ts':
    'takes a prebuilt `url` prop; composed by file-preview-tray-content.tsx from getApiBaseUrl()',
  'components/file-preview/renderers/audio-renderer.tsx':
    'takes a prebuilt `url` prop; same origin as use-file-content.ts above',
}

/**
 * Third-party endpoints. These are real-time voice/STT sockets opened straight
 * from the renderer to the provider, authenticated with a short-lived token the
 * API mints. They are not this app's API and must NOT follow its origin.
 */
const EXTERNAL_ENDPOINT_SITES = new Set([
  'lib/stt.ts',
  'lib/voice-agent-deepgram.ts',
  'lib/voice-agent-openai.ts',
])

/**
 * Modules that call `getApiBaseUrl()` directly instead of going through
 * `apiFetch`, and why the wrapper does not fit. Every entry is a URL handed to
 * something that cannot carry a request header.
 *
 * Growing this list is a real cost: each entry is a site that has to be
 * revisited by hand whenever the API origin changes.
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
  'components/notifications/global-notification-handler.tsx': 'EventSource — global notification stream',
  'hooks/use-message-stream.ts': 'EventSource — per-session message stream',
  'hooks/use-browser-stream.ts': 'WebSocket — browser view frames',
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

/**
 * Blank out the *contents* of comments and string literals, preserving length
 * and structure, so call-site scanning sees only code.
 *
 * Both halves earned their place. Prose describing a call reads exactly like
 * one — this file's own header would match, and so does a user-facing settings
 * string containing the words "use fetch (search still works)". Offsets are
 * preserved so arguments can be read back out of the original source.
 */
function maskCommentsAndStrings(source: string): string {
  const out = source.split('')
  let i = 0
  const blankTo = (end: number, from: number) => {
    for (let j = from; j < end && j < source.length; j++) {
      if (source[j] !== '\n') out[j] = ' '
    }
  }

  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      blankTo(end === -1 ? source.length : end, i)
      i = end === -1 ? source.length : end
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      blankTo(end === -1 ? source.length : end + 2, i)
      i = end === -1 ? source.length : end + 2
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i]
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === quote) break
        j++
      }
      // Keep the quotes themselves: the `/api` literal check reads them.
      blankTo(j, i + 1)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

/** Source with comments and string contents masked, keyed by renderer-relative path. */
function readMasked(file: string): string {
  return maskCommentsAndStrings(fs.readFileSync(file, 'utf-8'))
}

/** The first argument expression of a call whose `(` is at `openIndex`. */
function readFirstArgument(source: string, openIndex: number): string {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return source.slice(openIndex + 1, i)
    } else if (ch === ',' && depth === 1) {
      return source.slice(openIndex + 1, i)
    }
  }
  return source.slice(openIndex + 1)
}

interface CallSite {
  file: string
  primitive: string
  argument: string
}

/**
 * Every network primitive call in the renderer. `apiFetch`/`apiJson` are not
 * primitives — they are the wrapper, and are covered by `lib/api.ts` itself.
 *
 * Call sites are located in the masked source (so prose cannot look like code)
 * but arguments are read from the original at the same offsets, because the
 * argument's string contents are exactly what the `/api` check needs.
 */
function findNetworkCallSites(): CallSite[] {
  const sites: CallSite[] = []
  const pattern = /(?<![.\w])(?:new\s+(EventSource|WebSocket)|(fetch))\s*\(/g

  for (const file of collectSourceFiles(RENDERER_ROOT)) {
    const relative = path.relative(RENDERER_ROOT, file).split(path.sep).join('/')
    const source = fs.readFileSync(file, 'utf-8')

    for (const match of maskCommentsAndStrings(source).matchAll(pattern)) {
      const primitive = match[1] ?? match[2]
      const openIndex = match.index + match[0].length - 1
      sites.push({ file: relative, primitive, argument: readFirstArgument(source, openIndex) })
    }
  }
  return sites
}

/**
 * Whether a call site is accounted for. Either the URL expression visibly
 * derives from `getApiBaseUrl()`, or the enclosing module is one of the pinned
 * direct consumers — those routinely build the URL into a local `const` a line
 * or two above the call, which no single-expression check can follow. The
 * pinning test below is what keeps that second clause honest: the inventory is
 * asserted to be exactly this list, so it cannot quietly absorb a new module.
 */
function resolvesThroughBaseUrl(site: CallSite): boolean {
  return /getApiBaseUrl\(\)|\bbaseUrl\b/.test(site.argument) || site.file in DIRECT_BASE_URL_CONSUMERS
}

describe('renderer API origin', () => {
  it('routes every network primitive through getApiBaseUrl()', () => {
    const unaccounted = findNetworkCallSites().filter(
      (site) =>
        !resolvesThroughBaseUrl(site) &&
        !(site.file in UNRESOLVABLE_ARGUMENT_SITES) &&
        !EXTERNAL_ENDPOINT_SITES.has(site.file),
    )

    expect(
      unaccounted.map((s) => `${s.file}: ${s.primitive}(${s.argument.trim().slice(0, 80)})`),
    ).toEqual([])
  })

  it('never hardcodes a same-origin /api path into a network primitive', () => {
    // The failure this catches: `fetch('/api/agents')` works in the browser and
    // in Electron dev, and silently talks to the wrong server anywhere the API
    // is not the document's origin.
    const sameOrigin = findNetworkCallSites().filter((site) =>
      /^\s*[`'"]\/api\b/.test(site.argument),
    )

    expect(sameOrigin.map((s) => `${s.file}: ${s.primitive}`)).toEqual([])
  })

  it('pins the set of modules that compose API URLs without apiFetch', () => {
    const consumers = collectSourceFiles(RENDERER_ROOT)
      .filter((file) => /getApiBaseUrl/.test(readMasked(file)))
      .map((file) => path.relative(RENDERER_ROOT, file).split(path.sep).join('/'))
      .sort()

    // Sorted comparison so a failure names the file that appeared or vanished.
    expect(consumers).toEqual(Object.keys(DIRECT_BASE_URL_CONSUMERS).sort())
  })

  it('documents why each direct consumer cannot use apiFetch', () => {
    // Guards the list above against becoming a bare set of paths: an entry
    // without a reason is an entry nobody can evaluate later.
    for (const [file, reason] of Object.entries(DIRECT_BASE_URL_CONSUMERS)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(10)
    }
  })

  it('keeps third-party realtime sockets independent of the API origin', () => {
    // STT and voice-agent sockets connect straight to the provider with a
    // short-lived token. If one of these ever started deriving its URL from
    // getApiBaseUrl(), it would follow the API origin — and break, since the
    // provider is not this app.
    for (const file of EXTERNAL_ENDPOINT_SITES) {
      const source = readMasked(path.join(RENDERER_ROOT, file))
      expect(source, `${file} should not derive its socket URL from the API origin`).not.toMatch(
        /getApiBaseUrl/,
      )
    }
  })
})
