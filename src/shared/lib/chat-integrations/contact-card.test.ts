import { describe, it, expect, afterEach } from 'vitest'
import { buildAgentContactCard, resolveAgentWebUrl } from './contact-card'

const base = { slug: 'ada', name: 'Ada', appUrl: null }
const originalHostPublicUrl = process.env.HOST_PUBLIC_URL
const originalType = (process as { type?: string }).type

afterEach(() => {
  if (originalHostPublicUrl === undefined) delete process.env.HOST_PUBLIC_URL
  else process.env.HOST_PUBLIC_URL = originalHostPublicUrl
  if (originalType === undefined) delete (process as { type?: string }).type
  else (process as { type?: string }).type = originalType
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
      'N:Ada;;;;',
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
  it('returns null on desktop, where the app link is a superagent:// scheme no phone can open', () => {
    ;(process as { type?: string }).type = 'browser'
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    expect(resolveAgentWebUrl('ada')).toBeNull()
  })

  it('returns the https agent URL on a public web host', () => {
    delete (process as { type?: string }).type
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    expect(resolveAgentWebUrl('ada')).toBe('https://app.example.com/agents/ada')
  })

  it('returns null when the web host has no public URL', () => {
    delete (process as { type?: string }).type
    delete process.env.HOST_PUBLIC_URL
    expect(resolveAgentWebUrl('ada')).toBeNull()
  })
})
