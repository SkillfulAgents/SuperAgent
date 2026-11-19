import { describe, it, expect } from 'vitest'
import { parseNetworkActivity } from './network-activity'

const log = (requests: Array<Record<string, unknown>>): string => JSON.stringify({ success: true, data: { lifecycle: {}, requests } })

describe('parseNetworkActivity', () => {
  it('counts the requests issued and those with no response yet, leaving telemetry out', () => {
    expect(parseNetworkActivity(log([
      { requestId: '1', url: 'https://api.shop.com/products?cat=1', status: 200 },
      { requestId: '2', url: 'https://api.shop.com/products?cat=2' },
      { requestId: '3', url: 'https://www.google-analytics.com/g/collect?v=2' },
      { requestId: '4', url: 'https://shop.com/track?e=click' },
    ]))).toEqual({ issued: 2, pending: 1 })
    expect(parseNetworkActivity(log([]))).toEqual({ issued: 0, pending: 0 })
  })

  it('is null for anything that is not the log: an error, or output cut off', () => {
    expect(parseNetworkActivity('✗ Browser not launched')).toBeNull()
    expect(parseNetworkActivity(log([{ requestId: '1', url: 'https://a.com/x', status: 200 }]).slice(0, 60))).toBeNull()
  })
})
