import { describe, it, expect } from 'vitest'
import {
  buildDashboardArtifactPath,
  buildDashboardViewPath,
  buildDashboardViewUrl,
} from './dashboard-url'

// SUP-218: the Electron dashboard popout / iframe URL builders concatenated
// agentSlug and dashboardSlug into the local API path WITHOUT encoding each
// segment, so a slug containing a slash, space, or other path-significant
// character produced a wrong or broken path (and an embedded slash created an
// extra path segment). Each segment must be URL-encoded independently, matching
// the deep-link launcher and the screenshot URL.

describe('buildDashboardViewPath (SUP-218)', () => {
  it('URL-encodes agent and dashboard path segments', () => {
    // space -> %20, slash -> %2F (so "sales/report" stays a single segment).
    expect(buildDashboardViewPath('agent one', 'sales/report')).toBe(
      '/api/agents/agent%20one/artifacts/sales%2Freport/view',
    )
  })

  it('encodes a traversal-ish slug so it cannot escape its segment', () => {
    expect(buildDashboardViewPath('a', '../../etc')).toBe(
      '/api/agents/a/artifacts/..%2F..%2Fetc/view',
    )
  })

  it('leaves a plain slug unchanged', () => {
    expect(buildDashboardViewPath('sales-agent', 'weekly')).toBe(
      '/api/agents/sales-agent/artifacts/weekly/view',
    )
  })
})

describe('buildDashboardArtifactPath (SUP-218)', () => {
  it('encodes both segments and ends with a trailing slash for the iframe src', () => {
    expect(buildDashboardArtifactPath('agent one', 'sales/report')).toBe(
      '/api/agents/agent%20one/artifacts/sales%2Freport/',
    )
  })

  it('leaves a plain slug unchanged', () => {
    expect(buildDashboardArtifactPath('sales-agent', 'weekly')).toBe(
      '/api/agents/sales-agent/artifacts/weekly/',
    )
  })
})

describe('buildDashboardViewUrl (SUP-218)', () => {
  it('prefixes the encoded view path with the API base URL', () => {
    expect(buildDashboardViewUrl('http://localhost:3838', 'agent one', 'sales/report')).toBe(
      'http://localhost:3838/api/agents/agent%20one/artifacts/sales%2Freport/view',
    )
  })

  it('leaves a plain slug unchanged', () => {
    expect(buildDashboardViewUrl('http://localhost:3838', 'sales-agent', 'weekly')).toBe(
      'http://localhost:3838/api/agents/sales-agent/artifacts/weekly/view',
    )
  })
})

describe('buildDashboardViewUrl against a cloud workspace', () => {
  // Popouts are built in the main process, which has no renderer to ask. Given a
  // bare local origin they open the LOCAL deployment's dashboard for an agent
  // slug belonging to the cloud one — a 404, or someone else's agent of the same
  // name. The cloud base URL is the local origin plus the proxy prefix.
  it('keeps the proxy prefix ahead of the encoded view path', () => {
    expect(
      buildDashboardViewUrl('http://localhost:3838/api/cloud-proxy/abc123', 'sales agent', 'weekly'),
    ).toBe('http://localhost:3838/api/cloud-proxy/abc123/api/agents/sales%20agent/artifacts/weekly/view')
  })
})
