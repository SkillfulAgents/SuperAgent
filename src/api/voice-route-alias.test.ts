import { describe, expect, it } from 'vitest'
import app from './index'

/**
 * The voice router moved from /api/stt to /api/voice when it outgrew speech
 * recognition (it also mints voice-agent and text-to-speech credentials).
 * The old prefix stays mounted: the speech-recognition polyfill is cached in
 * browsers for an hour and fetches its token from the prefix it was built
 * with, and third-party dashboards may have the old paths baked in. Assert
 * against the real app so a re-ordering or a dropped mount is caught.
 */
describe('voice routes answer under both prefixes', () => {
  it.each(['/api/voice/configured', '/api/stt/configured'])('%s', async (path) => {
    const res = await app.request(path)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ configured: expect.any(Boolean), supportsTts: expect.any(Boolean) })
  })
})
