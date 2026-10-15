import { afterEach, describe, expect, it, vi } from 'vitest'
import { s3Fixture } from './testing/s3-fixture'
import { validateS3Volume } from './s3-validation'
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
afterEach(() => vi.restoreAllMocks())

describe('S3 setup permission checks', () => {
  it('validates required access using only disposable objects inside the chosen prefix', async () => {
    const f = s3Fixture(); f.put('user-file', Buffer.from('untouched'))
    const result = await validateS3Volume(f.config)
    expect(result.valid).toBe(true)
    expect(result.checks).toHaveLength(8)
    expect(result.warnings).toEqual([])
    expect([...f.objects.keys()]).toEqual(['mounted/user-file'])
    expect(f.sessions.size).toBe(0)
    expect(f.requests.filter(request => request.method !== 'GET' && request.method !== 'HEAD').every(request => request.key.startsWith('mounted/.gamut-check-'))).toBe(true)
  })

  it('explains read-only credentials and prevents creation', async () => {
    const f = s3Fixture()
    f.deny(request => request.method === 'PUT' || request.method === 'DELETE' ? 'AccessDenied' : undefined)
    const result = await validateS3Volume(f.config)
    expect(result.valid).toBe(false)
    expect(result.checks.find(check => check.label === 'Create and overwrite objects')).toMatchObject({ status: 'failed', message: expect.stringContaining('permissions') })
    expect(result.checks.find(check => check.label === 'Read objects')?.status).toBe('skipped')
  })

  it('identifies missing delete permission and the exact disposable keys requiring cleanup', async () => {
    const f = s3Fixture(); f.deny(request => request.method === 'DELETE' && !request.query?.uploadId ? 'AccessDenied' : undefined)
    const result = await validateS3Volume(f.config)
    expect(result.valid).toBe(false)
    expect(result.checks.find(check => check.label === 'Delete objects')).toMatchObject({ status: 'failed', message: expect.stringContaining('s3:DeleteObject') })
    expect(result.warnings.join(' ')).toContain('mounted/.gamut-check-')
    expect(f.objects.size).toBeGreaterThan(0)
  })

  it.each(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken'])('reports authentication failure %s without echoing credentials', async code => {
    const f = s3Fixture(); f.deny(() => code)
    const result = await validateS3Volume(f.config)
    expect(result.valid).toBe(false)
    expect(result.checks[0].message).toContain('authenticate')
    expect(JSON.stringify(result)).not.toContain(f.config.credentials.secretAccessKey)
    expect(JSON.stringify(result)).not.toContain(f.config.credentials.accessKeyId)
    expect(f.objects.size).toBe(0)
  })

  it('checks multipart abort separately and cleans every completed test object', async () => {
    const f = s3Fixture(); f.deny(request => request.method === 'DELETE' && request.query?.uploadId ? 'AccessDenied' : undefined)
    const result = await validateS3Volume(f.config)
    expect(result.valid).toBe(false)
    expect(result.checks.find(check => check.label === 'Cancel unfinished uploads')?.status).toBe('failed')
    expect(result.warnings.join(' ')).toContain('unfinished test upload')
    expect(f.objects.size).toBe(0)
  })
})
