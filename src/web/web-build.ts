import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, Hono } from 'hono'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getServerFacts, withServerFacts } from '@shared/lib/facts/server-facts'

// Cache policy for the static web build. Vite emits content-hashed JS/CSS into
// `/assets/*`, so the filename itself changes whenever the bytes change — those
// can be cached permanently and a new deploy is picked up automatically (new
// URLs, nothing to invalidate). `index.html` is the un-hashed entry that points
// at the hashed bundles, so it must always be revalidated or clients pin to a
// stale build. Stable-named `public/` assets (icons, manifest) have no hash to
// bust them, so they revalidate too rather than caching forever.
function staticCacheControl(filePath: string): string {
  const p = filePath.replace(/\\/g, '/')
  if (p.includes('/assets/')) return 'public, max-age=31536000, immutable'
  if (p.endsWith('index.html')) return 'no-cache'
  // The service worker script is the update trigger for the whole precached
  // asset set — browsers revalidate it on their own schedule, but an explicit
  // no-cache removes any intermediary-cache delay on picking up a deploy.
  if (p.endsWith('/sw.js')) return 'no-cache'
  return 'public, max-age=3600, must-revalidate'
}

/** Serve the built renderer in `root`: its files, and its HTML entry for every other route. */
export function mountWebBuild(app: Hono, root: string): void {
  // The HTML entry carries this server's facts, so a page knows them before its
  // first render without another request. Built once: they can't change while
  // the process runs. Never cached, so a reload always discovers the latest
  // hashed bundles.
  const indexHtml = withServerFacts(readFileSync(join(root, 'index.html'), 'utf-8'), getServerFacts())
  const serveIndex = (c: Context) => {
    c.header('Cache-Control', 'no-cache')
    return c.html(indexHtml)
  }
  // Ahead of the static middleware, which would serve the file as built. The
  // service worker precaches `/index.html`, so that path needs the facts too.
  app.get('/', serveIndex)
  app.get('/index.html', serveIndex)
  app.use(
    '/*',
    serveStatic({
      root,
      onFound: (filePath, c) => c.header('Cache-Control', staticCacheControl(filePath)),
    }),
  )
  // SPA fallback: any unmatched route serves the HTML entry.
  app.get('*', serveIndex)
}
