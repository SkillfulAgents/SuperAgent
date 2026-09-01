import { describe, expect, it } from 'vitest'
import app from './index'

/**
 * The `/api/*` default is uncacheable (see middleware/default-cache-control),
 * which is only safe if the handful of routes that genuinely want a CDN copy
 * keep theirs. These are public, auth-free, immutable-per-deploy bundles that
 * every dashboard iframe pulls, so losing their caching would be a silent
 * bandwidth regression rather than a visible failure — assert it against the
 * real app rather than a stand-in router, since registration order is what
 * decides whether the middleware sees a route's own header at all.
 */
describe('public API bundles stay CDN-cacheable', () => {
  it.each([
    ['/api/stt/speech-recognition-polyfill.js', 'public, max-age=3600'],
    ['/api/llm/anthropic-polyfill.js', 'public, max-age=3600'],
    ['/api/llm/anthropic-sdk.js', 'public, max-age=86400'],
  ])('%s keeps %s', async (path, expected) => {
    const res = await app.request(path)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(expected)
  })
})
