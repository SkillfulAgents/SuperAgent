import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot } from '@shared/lib/dashboard-inspect-schema'
import { parseUserMessageParts } from '@shared/lib/utils/user-message-parts'
import { buildDashboardCommentMessage, dashboardRoute, type DashboardCommentInput } from './dashboard-comment-message'

const NOW = 1_800_000_000_000

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    url: 'http://localhost:47891/api/agents/sales/artifacts/revenue/#/regions?q=3',
    basePath: '/api/agents/sales/artifacts/revenue/',
    title: 'Revenue',
    viewport: { width: 1000, height: 600 },
    scroll: { x: 0, y: 0, width: 1000, height: 600 },
    devicePixelRatio: 2,
    selection: '',
    element: null,
    logs: [],
    droppedLogs: 0,
    ...overrides,
  }
}

function input(overrides: Partial<DashboardCommentInput> = {}): DashboardCommentInput {
  return {
    comment: 'Make the bars blue',
    dictated: false,
    dashboard: { name: 'Revenue', slug: 'revenue' },
    pin: null,
    frame: { width: 1000, height: 600 },
    opened: snapshot(),
    sent: snapshot(),
    screenshotPath: '/workspace/uploads/dashboard-comment-revenue.png',
    screenshotGap: null,
    theme: 'dark',
    now: NOW,
    ...overrides,
  }
}

describe('dashboardRoute', () => {
  it('gives the route past the dashboard mount', () => {
    expect(dashboardRoute('http://h/api/agents/a/artifacts/d/settings?tab=2#x', '/api/agents/a/artifacts/d/')).toBe('/settings?tab=2#x')
    expect(dashboardRoute('http://h/api/agents/a/artifacts/d', '/api/agents/a/artifacts/d/')).toBe('/')
  })

  it('keeps a URL off the mount whole', () => {
    expect(dashboardRoute('https://elsewhere.test/page', '/api/agents/a/artifacts/d/')).toBe('/page')
    expect(dashboardRoute('not a url')).toBe('not a url')
  })
})

describe('buildDashboardCommentMessage', () => {
  it('leads with the comment, then the context, then the screenshot as an attachment', () => {
    const message = buildDashboardCommentMessage(input())
    const parts = parseUserMessageParts(message)

    expect(parts.text).toBe('Make the bars blue')
    expect(parts.attachedFiles).toEqual(['/workspace/uploads/dashboard-comment-revenue.png'])
    expect(parts.dashboardContext).toContain('files in /workspace/artifacts/revenue/')
    expect(parts.dashboardContext).toContain('- Page: `/#/regions?q=3`')
    expect(parts.dashboardContext).toContain('- Viewport: 1000×600 CSS px, dark theme')
    expect(parts.dashboardContext).toContain('Not pinned to a spot')
    expect(parts.dashboardContext).toContain('Screenshot of what they saw (before the comment overlay): /workspace/uploads/dashboard-comment-revenue.png')
    expect(parts.dashboardContext).toContain('They are not watching this conversation')
  })

  it('places the pin in pixels and names what was under it', () => {
    const message = buildDashboardCommentMessage(input({
      pin: { x: 25, y: 50 },
      sent: snapshot({
        element: {
          tag: 'rect.bar',
          path: 'main > svg.chart > rect.bar',
          text: '',
          context: 'Q3 revenue by region, EMEA 1.2M',
          label: 'EMEA',
          rect: { x: 240, y: 280, width: 30, height: 60 },
        },
      }),
    }))

    expect(message).toContain('- Pinned at (250, 300) px in the viewport, 25% across and 50% down; a magenta ring marks it in the screenshot')
    expect(message).toContain('- Under the pin: <rect.bar>, labelled "EMEA", inside text "Q3 revenue by region, EMEA 1.2M"; path `main > svg.chart > rect.bar`')
  })

  it('says why there is no screenshot', () => {
    expect(buildDashboardCommentMessage(input({ screenshotPath: null, screenshotGap: 'unsupported' })))
      .toContain('- No screenshot (this window cannot capture the page): open the dashboard yourself to see it')
    const failed = buildDashboardCommentMessage(input({ screenshotPath: null, screenshotGap: 'failed', pin: { x: 1, y: 1 } }))
    expect(failed).toContain('- No screenshot (capturing the page failed)')
    expect(failed).not.toContain('magenta ring')
    expect(parseUserMessageParts(failed).attachedFiles).toEqual([])
  })

  it('fences the console log past any backticks it holds, with times relative to the comment', () => {
    const message = buildDashboardCommentMessage(input({
      sent: snapshot({
        logs: [
          { level: 'log', at: NOW - 125_000, text: 'loaded ```data```' },
          { level: 'error', at: NOW - 4_200, text: 'Uncaught TypeError: x is undefined' },
          { level: 'network', at: NOW - 1_000, text: 'GET /api/data -> 500 Internal Server Error' },
        ],
        droppedLogs: 7,
      }),
    }))

    expect(message).toContain('(the last 3 of 10 entries since it loaded; 1 error, 0 warnings, 1 failed request)')
    expect(message).toContain('````text\n-2m05s [log] loaded ```data```\n-4.2s [error] Uncaught TypeError: x is undefined\n-1.0s [network] GET /api/data -> 500 Internal Server Error\n````')
  })

  it('tallies errors the kept log no longer holds, from the page\'s running counts', () => {
    const message = buildDashboardCommentMessage(input({
      sent: snapshot({
        logs: [{ level: 'log', at: NOW - 1_000, text: 'tick' }],
        droppedLogs: 300,
        counts: { error: 50, log: 251 },
      }),
    }))
    expect(message).toContain('(the last 1 of 301 entries since it loaded; 50 errors, 0 warnings, 0 failed requests)')
  })

  it('tells a failed upload from a failed capture', () => {
    expect(buildDashboardCommentMessage(input({ screenshotPath: null, screenshotGap: 'upload-failed' })))
      .toContain('- No screenshot (it was captured but could not be uploaded): open the dashboard yourself to see it')
  })

  it('says when the page did not answer, and when it logged nothing', () => {
    expect(buildDashboardCommentMessage(input({ opened: null, sent: null }))).toContain('Console output is not available')
    expect(buildDashboardCommentMessage(input())).toContain('The dashboard logged nothing to the console')
  })

  it('quotes page text with its quotes escaped', () => {
    const message = buildDashboardCommentMessage(input({ opened: snapshot({ selection: 'say "hi"' }) }))
    expect(message).toContain('- Text they had selected: "say \\"hi\\""')
  })

  it('notes a dictated comment for the agent, outside what the bubble shows', () => {
    const message = buildDashboardCommentMessage(input({ dictated: true }))
    expect(message).toMatch(/\[Voice dictated:[^\n]*\]$/)
    expect(parseUserMessageParts(message).text).toBe('Make the bars blue')
  })
})
