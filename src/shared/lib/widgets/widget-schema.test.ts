import { describe, it, expect } from 'vitest'
import { isWidgetStale, widgetSnapshotSchema, type WidgetSnapshot } from './widget-schema'

const now = Date.parse('2026-09-07T12:00:00Z')

function snap(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
  return widgetSnapshotSchema.parse({
    generatedAt: '2026-09-07T11:00:00Z',
    validUntil: '2026-09-07T13:00:00Z',
    validityDefaulted: false,
    htmlHash: 'abc',
    renderedSizes: [],
    scriptRan: true,
    durationMs: 10,
    lastError: null,
    ...overrides,
  })
}

describe('isWidgetStale', () => {
  const scripted = { hasHtml: true, hasScript: true, htmlHash: 'abc' }

  it('is stale with no snapshot at all', () => {
    expect(isWidgetStale(scripted, null, now)).toBe(true)
  })

  it('is fresh while validUntil is in the future and the html matches', () => {
    expect(isWidgetStale(scripted, snap(), now)).toBe(false)
  })

  it('is stale once validUntil has passed', () => {
    expect(isWidgetStale(scripted, snap({ validUntil: '2026-09-07T11:59:59Z' }), now)).toBe(true)
  })

  it('is stale when widget.html changed since the snapshot (an agent run rewrote it)', () => {
    expect(isWidgetStale({ ...scripted, htmlHash: 'changed' }, snap(), now)).toBe(true)
  })

  it('a scriptless widget with a matching hash never expires', () => {
    const staticWidget = { hasHtml: true, hasScript: false, htmlHash: 'abc' }
    expect(isWidgetStale(staticWidget, snap({ validUntil: null }), now)).toBe(false)
    expect(isWidgetStale(staticWidget, snap({ validUntil: '2000-01-01T00:00:00Z' }), now)).toBe(true)
  })

  it('an empty directory (no html, no script) has nothing to refresh', () => {
    expect(isWidgetStale({ hasHtml: false, hasScript: false, htmlHash: null }, null, now)).toBe(false)
  })

  it('treats an unparseable validUntil as stale', () => {
    expect(isWidgetStale(scripted, snap({ validUntil: 'not-a-date' }), now)).toBe(true)
  })
})
