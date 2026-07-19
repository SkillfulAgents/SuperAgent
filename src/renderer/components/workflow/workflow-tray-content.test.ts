import { describe, it, expect } from 'vitest'
import { overlayLiveStatus, progressSummary, workflowProgressSegments } from './workflow-tray-content'
import type { WorkflowAgentNode } from '@shared/lib/workflows/workflow-schemas'

function node(over: Partial<WorkflowAgentNode>): WorkflowAgentNode {
  return {
    agentId: 'a',
    label: 'agent',
    phase: 'P',
    status: 'running',
    result: null,
    resolved: 'prompt-regex',
    prompt: '',
    toolCount: 0,
    tokens: 0,
    durationMs: null,
    ...over,
  }
}

describe('overlayLiveStatus', () => {
  it('returns the base tree unchanged when there is no live data', () => {
    const base = [node({ agentId: 'a', status: 'done', result: 'x' })]
    expect(overlayLiveStatus(base, undefined)).toBe(base)
  })

  it('upgrades a tree running → done from a live done event', () => {
    const base = [node({ agentId: 'a', status: 'running', result: null })]
    const out = overlayLiveStatus(base, { a: { status: 'done', result: 'A done' } })
    expect(out[0]).toMatchObject({ status: 'done', result: 'A done' })
  })

  it('does NOT let a stale live running override a tree done (the missed-final-line bug)', () => {
    const base = [node({ agentId: 'aa18', status: 'done', result: 'all done' })]
    const out = overlayLiveStatus(base, { aa18: { status: 'running', result: null } })
    expect(out[0]).toMatchObject({ status: 'done', result: 'all done' })
  })

  it('keeps an agent running when both sources say running', () => {
    const base = [node({ agentId: 'a', status: 'running' })]
    const out = overlayLiveStatus(base, { a: { status: 'running', result: null } })
    expect(out[0].status).toBe('running')
  })

  it('prefers the disk result but falls back to the live result', () => {
    const base = [node({ agentId: 'a', status: 'running', result: null })]
    const out = overlayLiveStatus(base, { a: { status: 'done', result: 'live result' } })
    expect(out[0].result).toBe('live result')
  })

  it('surfaces a live failed state', () => {
    const base = [node({ agentId: 'a', status: 'running', result: null })]
    const out = overlayLiveStatus(base, { a: { status: 'failed', result: null } })
    expect(out[0].status).toBe('failed')
  })

  it('does NOT let a stale live running override a tree failed (trailing-error detection)', () => {
    const base = [node({ agentId: 'a', status: 'failed', result: 'request_too_large: 413' })]
    const out = overlayLiveStatus(base, { a: { status: 'running', result: null } })
    expect(out[0]).toMatchObject({ status: 'failed', result: 'request_too_large: 413' })
  })

  it('lets done win over failed when the sources disagree (a result is definitive)', () => {
    const base = [node({ agentId: 'a', status: 'failed', result: 'err' })]
    const out = overlayLiveStatus(base, { a: { status: 'done', result: 'late result' } })
    expect(out[0].status).toBe('done')
  })

  it('overlays live tokens/toolCount/lastTool onto the node', () => {
    const base = [node({ agentId: 'a', status: 'running', tokens: 1, toolCount: 0 })]
    const out = overlayLiveStatus(base, {
      a: { status: 'running', result: null, tokens: 500, toolCount: 3, lastTool: 'Bash sleep 40' },
    })
    expect(out[0]).toMatchObject({ tokens: 500, toolCount: 3, lastTool: 'Bash sleep 40' })
  })
})

describe('workflowProgressSegments', () => {
  it('colors known agents by status', () => {
    const agents = [node({ agentId: 'a', status: 'done' }), node({ agentId: 'b', status: 'running' })]
    expect(workflowProgressSegments(agents, 0)).toEqual(['done', 'running'])
  })

  it('adds gray pending cells for declared-but-not-started agents', () => {
    const agents = [node({ agentId: 'a', status: 'done' }), node({ agentId: 'b', status: 'running' })]
    // 3 call sites, 2 started → 1 pending
    expect(workflowProgressSegments(agents, 3)).toEqual(['done', 'running', 'pending'])
  })

  it('never shows phantom pending when the fan-out exceeds the call-site count', () => {
    const agents = [
      node({ agentId: 'a', status: 'done' }),
      node({ agentId: 'b', status: 'done' }),
      node({ agentId: 'c', status: 'running' }),
    ]
    // 1 map call site spawned 3 agents → no pending, bar just grew
    expect(workflowProgressSegments(agents, 1)).toEqual(['done', 'done', 'running'])
  })

  it('returns no segments before anything is known', () => {
    expect(workflowProgressSegments([], 0)).toEqual([])
  })

  it('maps a failed agent to a red (failed) segment', () => {
    const agents = [node({ agentId: 'a', status: 'done' }), node({ agentId: 'b', status: 'failed' })]
    expect(workflowProgressSegments(agents, 0)).toEqual(['done', 'failed'])
  })

  it('drops pending cells once the run is no longer active', () => {
    const agents = [node({ agentId: 'a', status: 'done' })]
    // The estimate said 3 but the run finished with 1 — whatever didn't start never will.
    expect(workflowProgressSegments(agents, 3, false)).toEqual(['done'])
  })
})

describe('progressSummary', () => {
  it('reads "N/M agents done" when nothing failed', () => {
    expect(progressSummary(['done', 'done', 'running', 'pending'])).toBe('2/4 agents done')
  })

  it('counts failed agents as finished and calls them out', () => {
    // 22 done + 1 failed + 1 running must not read "22/24 done" — 23 have finished.
    const segs = Array<'done' | 'failed' | 'running'>(22).fill('done').concat('failed', 'running')
    expect(progressSummary(segs)).toBe('23/24 agents finished · 1 failed')
  })
})
