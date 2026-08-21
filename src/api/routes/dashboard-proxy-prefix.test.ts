import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

/**
 * A dashboard served through the desktop cloud proxy must stay inside the
 * proxy's prefix.
 *
 * The desktop drives a remote deployment through `/cloud/<key>` on the local
 * origin, and the deployment is deliberately never told that prefix exists
 * (`cloud-proxy-key.ts`). Anything the dashboard emits as a root-absolute URL
 * therefore resolves against the origin, loses the prefix, and reaches the
 * local API instead of the deployment, which answers 404. A dashboard whose
 * entry module 404s never mounts and paints an empty `#root`.
 *
 * The browser is modelled the way it actually behaves, which is the part that
 * makes this bug survive the obvious fixes: URLs are resolved against the
 * *statically parsed* `<base>`, not the corrected one. Chromium's preload
 * scanner runs ahead of the parser and does not see a `<base>` that a later
 * inline script rewrites, so correcting the base from the injected runtime
 * lands after the fetches have already been issued.
 */

let remoteAddress: string | undefined = '127.0.0.1'
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => ({ remote: { address: remoteAddress } }),
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

const mockResolveTarget = vi.fn()
const mockRefreshTarget = vi.fn()
vi.mock('@shared/lib/services/cloud-proxy-target', () => ({
  resolveCloudProxyTarget: () => mockResolveTarget(),
  refreshCloudProxyTarget: () => mockRefreshTarget(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import cloudProxy, { CLOUD_PROXY_PREFIX } from './cloud-proxy'
import { getCloudProxyKey } from '@shared/lib/services/cloud-proxy-key'
import { injectDashboardRuntime, dashboardMountPath } from '../dashboard-runtime'

const app = new Hono()
app.route(CLOUD_PROXY_PREFIX, cloudProxy)

const TARGET = { deploymentUrl: 'https://workspace.example.com', token: 'deployment-token' }
const ORIGIN = 'http://127.0.0.1:3000'
const AGENT = 'a0i89srqo6'
const SLUG = 'open-slide-studio'
const MOUNT = dashboardMountPath(AGENT, SLUG)

function proxiedPath(suffix: string): string {
  return `${CLOUD_PROXY_PREFIX}/${getCloudProxyKey()}${suffix}`
}

/**
 * What a Vite dev server serves at a dashboard mount: an empty shell whose
 * entry points are root-absolute, built from the `base` it was configured
 * with. Passed through the real injection so the fixture tracks production.
 */
function upstreamDocument(): string {
  return injectDashboardRuntime(
    '<!doctype html><html><head>'
    + `<script type="module" src="${MOUNT}@vite/client"></script>`
    + '</head><body><div id="root"></div>'
    + `<script type="module" src="${MOUNT}main.tsx"></script>`
    + '</body></html>',
    { basePath: MOUNT, slug: SLUG },
  )
}

/** Vite rewrites every import specifier to the same root-absolute base. */
function upstreamEntryModule(): string {
  return [
    `import "${MOUNT}@fs/workspace/node_modules/vite/dist/client/env.mjs";`,
    `import App from "${MOUNT}app.tsx";`,
    `import "${MOUNT}styles.css";`,
  ].join('\n')
}

/** Same-origin urls the browser is told to fetch from a document. */
function documentAssetUrls(html: string): string[] {
  return [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^[a-z]+:/i.test(u) && !u.startsWith('//'))
}

/** Same-origin specifiers the browser is told to fetch from a module. */
function moduleImportUrls(js: string): string[] {
  return [...js.matchAll(/(?:from|import)\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^[a-z]+:/i.test(u) && !u.startsWith('//'))
}

/**
 * Resolve as the preload scanner does: against the `<base>` present in the
 * markup, before any script has had a chance to correct it.
 */
function resolveStatically(url: string, documentUrl: string, html?: string): string {
  const declaredBase = html?.match(/<base\b[^>]*\bhref="([^"]*)"/i)?.[1]
  const base = declaredBase ? new URL(declaredBase, documentUrl).toString() : documentUrl
  return new URL(url, base).pathname
}

beforeEach(() => {
  vi.clearAllMocks()
  remoteAddress = '127.0.0.1'
  mockResolveTarget.mockReturnValue(TARGET)
  mockRefreshTarget.mockResolvedValue(null)
})

describe('dashboard served through the cloud proxy prefix', () => {
  it('keeps the document\'s asset urls inside the proxy prefix', async () => {
    mockFetch.mockResolvedValue(
      new Response(upstreamDocument(), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )

    const documentPath = proxiedPath(MOUNT)
    const res = await app.request(`${ORIGIN}${documentPath}`, {
      headers: { accept: 'text/html' },
    })
    expect(res.status).toBe(200)

    const html = await res.text()
    const documentUrl = `${ORIGIN}${documentPath}`
    const assets = documentAssetUrls(html)
    expect(assets.length).toBeGreaterThan(0)

    for (const asset of assets) {
      const resolved = resolveStatically(asset, documentUrl, html)
      expect(
        resolved.startsWith(`${CLOUD_PROXY_PREFIX}/`),
        `asset "${asset}" left the proxy prefix: resolved to ${resolved}`,
      ).toBe(true)
    }
  })

  it('keeps a relative asset url inside the proxy prefix', async () => {
    // Relative urls are the usual advice for a proxied app, and they do not
    // help here: the injected `<base>` names the mount without the prefix, so
    // the scanner resolves against that rather than against the document url.
    mockFetch.mockResolvedValue(
      new Response(
        injectDashboardRuntime(
          '<!doctype html><html><head><link rel="stylesheet" href="./app.css" />'
          + '</head><body><div id="root"></div>'
          + '<script type="module" src="./main.js"></script></body></html>',
          { basePath: MOUNT, slug: SLUG },
        ),
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    )

    const documentPath = proxiedPath(MOUNT)
    const html = await (
      await app.request(`${ORIGIN}${documentPath}`, { headers: { accept: 'text/html' } })
    ).text()

    for (const asset of documentAssetUrls(html)) {
      const resolved = resolveStatically(asset, `${ORIGIN}${documentPath}`, html)
      expect(
        resolved.startsWith(`${CLOUD_PROXY_PREFIX}/`),
        `asset "${asset}" left the proxy prefix: resolved to ${resolved}`,
      ).toBe(true)
    }
  })

  it('keeps the entry module\'s imports inside the proxy prefix', async () => {
    mockFetch.mockResolvedValue(
      new Response(upstreamEntryModule(), {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }),
    )

    const modulePath = proxiedPath(`${MOUNT}main.tsx`)
    const res = await app.request(`${ORIGIN}${modulePath}`)
    expect(res.status).toBe(200)

    const js = await res.text()
    const imports = moduleImportUrls(js)
    expect(imports.length).toBeGreaterThan(0)

    for (const specifier of imports) {
      const resolved = new URL(specifier, `${ORIGIN}${modulePath}`).pathname
      expect(
        resolved.startsWith(`${CLOUD_PROXY_PREFIX}/`),
        `import "${specifier}" left the proxy prefix: resolved to ${resolved}`,
      ).toBe(true)
    }
  })
})
