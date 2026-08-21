import { describe, it, expect } from 'vitest'
import {
  parseIframeInfo,
  formatIframePlaceholders,
  capSnapshot,
  SNAPSHOT_SOFT_CAP_CHARS,
  type IframeInfo,
} from './snapshot-format'

describe('parseIframeInfo', () => {
  it('parses CLI double-encoded eval output', () => {
    const raw = JSON.stringify(JSON.stringify([
      { title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false },
    ]))
    expect(parseIframeInfo(raw)).toEqual([
      { title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false },
    ])
  })

  it('parses plain JSON and fills missing fields', () => {
    expect(parseIframeInfo('[{"host":"x.com"}]')).toEqual([
      { title: '', host: 'x.com', sameOrigin: false },
    ])
  })

  it('returns [] on garbage or non-arrays', () => {
    expect(parseIframeInfo('✗ error')).toEqual([])
    expect(parseIframeInfo('"not an array"')).toEqual([])
  })
})

describe('formatIframePlaceholders', () => {
  it('lists cross-origin frames with the payment recipe', () => {
    const frames: IframeInfo[] = [{ title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false }]
    const out = formatIframePlaceholders(frames)
    expect(out).toContain('js.stripe.com')
    expect(out).toContain('Secure payment input frame')
    expect(out).toContain('browser_type')
  })

  it('omits same-origin frames (already merged into the tree)', () => {
    const frames: IframeInfo[] = [{ title: 'inner', host: 'self.com', sameOrigin: true }]
    expect(formatIframePlaceholders(frames)).toBe('')
  })

  it('omits srcless/blank frames (no host)', () => {
    expect(formatIframePlaceholders([{ title: '', host: '', sameOrigin: false }])).toBe('')
  })

  it('returns empty string when there are no opaque frames', () => {
    expect(formatIframePlaceholders([])).toBe('')
  })
})

describe('capSnapshot', () => {
  it('passes through snapshots under the cap', () => {
    expect(capSnapshot('- button "x" [ref=e1]', false)).toBe('- button "x" [ref=e1]')
  })

  it('truncates over-cap snapshots and suggests scope', () => {
    const out = capSnapshot('e'.repeat(SNAPSHOT_SOFT_CAP_CHARS + 5000), false)
    expect(out.length).toBeLessThan(SNAPSHOT_SOFT_CAP_CHARS + 300)
    expect(out).toContain('snapshot truncated')
    expect(out).toContain('scope=')
  })

  it('gives a tighter-scope hint when already scoped', () => {
    const out = capSnapshot('e'.repeat(SNAPSHOT_SOFT_CAP_CHARS + 5000), true)
    expect(out).toContain('tighter scope')
  })
})
