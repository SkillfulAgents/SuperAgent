import { describe, expect, it } from 'vitest'
import app from './index'
import { WORKSPACE_UNAVAILABLE_HEADER } from '@shared/lib/workspace-unavailable-header'

// The packaged renderer is file:// (Origin: null) calling loopback, so the
// browser only lets it read a custom response header the server exposes.
describe('CORS exposes the workspace-unavailable header', () => {
  it('lists x-workspace-unavailable in Access-Control-Expose-Headers on a real response', async () => {
    const res = await app.request('/api/voice/speech-recognition-polyfill.js', {
      headers: { origin: 'null' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const exposed = res.headers.get('access-control-expose-headers')?.toLowerCase().split(',') ?? []
    expect(exposed).toContain(WORKSPACE_UNAVAILABLE_HEADER)
  })
})
