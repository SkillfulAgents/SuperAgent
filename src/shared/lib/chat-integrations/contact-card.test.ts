import { describe, it, expect, afterEach, vi } from 'vitest'
import { readCloudWorkspaceRecord } from '@shared/lib/platform-auth/cloud-workspace-record'
import { buildAgentContactCard, resolveAgentWebUrl } from './contact-card'

vi.mock('@shared/lib/platform-auth/cloud-workspace-record', () => ({
  readCloudWorkspaceRecord: vi.fn(),
}))

const base = { slug: 'ada', name: 'Ada', appUrl: null }
const originalHostPublicUrl = process.env.HOST_PUBLIC_URL

afterEach(() => {
  if (originalHostPublicUrl === undefined) delete process.env.HOST_PUBLIC_URL
  else process.env.HOST_PUBLIC_URL = originalHostPublicUrl
  vi.mocked(readCloudWorkspaceRecord).mockReset()
})

describe('buildAgentContactCard', () => {
  it('escapes backslashes, commas, semicolons, and newlines in the note', () => {
    const vcf = buildAgentContactCard({
      ...base,
      description: 'Triages inbox, calendar; uses C:\\Gamut\rand digests',
    }).toString('utf8')
    expect(vcf).toContain('NOTE:Triages inbox\\, calendar\\; uses C:\\\\Gamut\\nand digests')
  })

  it('includes the required fields and ends with CRLF', () => {
    const vcf = buildAgentContactCard(base).toString('utf8')
    for (const field of [
      'UID:gamut-agent-ada',
      'FN:Ada',
      'TITLE:AI Agent',
      'ORG:Gamut',
      'TEL;type=IPHONE;type=pref:+12053967934',
      'PHOTO;ENCODING=b;TYPE=JPEG:',
    ]) {
      expect(vcf).toContain(field)
    }
    expect(vcf.endsWith('\r\n')).toBe(true)
  })

  it('folds a long line at 75 octets with CRLF and a leading space', () => {
    const vcf = buildAgentContactCard({
      ...base,
      description: 'x'.repeat(200),
    }).toString('utf8')
    for (const line of vcf.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    }
    expect(vcf).toContain('\r\n ')
  })

  it('never splits a multi-byte character when folding', () => {
    const vcf = buildAgentContactCard({
      ...base,
      description: '🙂'.repeat(60),
    }).toString('utf8')
    // A split surrogate would decode to U+FFFD.
    expect(vcf).not.toContain('�')
  })

  it('uses the marketing row when there is no agent URL', () => {
    const vcf = buildAgentContactCard(base).toString('utf8')
    expect(vcf).toContain('item1.URL:https://gamut.so')
    expect(vcf).toContain('item1.X-ABLabel:Gamut')
    expect(vcf).not.toContain('superagent://')
  })

  it('uses the agent row when an https URL exists', () => {
    const vcf = buildAgentContactCard({
      ...base,
      appUrl: 'https://app.example.com/agents/ada',
    }).toString('utf8')
    expect(vcf).toContain('item1.URL:https://app.example.com/agents/ada')
    expect(vcf).toContain('item1.X-ABLabel:Open in Gamut')
  })

  it('omits NOTE entirely when the agent has no description', () => {
    expect(buildAgentContactCard(base).toString('utf8')).not.toContain('NOTE:')
  })
})

describe('resolveAgentWebUrl', () => {
  it('returns null when no public or cloud URL exists', () => {
    delete process.env.HOST_PUBLIC_URL
    vi.mocked(readCloudWorkspaceRecord).mockReturnValue(null)
    expect(resolveAgentWebUrl('ada')).toBeNull()
  })
})
