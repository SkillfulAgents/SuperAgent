// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderPendingRequest, type RenderContext } from './pending-request-renderer'
import type { PendingRequestDescriptor } from './use-pending-requests'
import { SecretRequestItem } from './secret-request-item'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'
import { QuestionRequestItem } from './question-request-item'
import { FileRequestItem } from './file-request-item'
import { BrowserInputRequestItem } from './browser-input-request-item'
import { ScriptRunRequestItem } from './script-run-request-item'
import { ComputerUseRequestItem } from './computer-use-request-item'
import { ProxyReviewRequestItem } from './proxy-review-request-item'
import { XAgentReviewRequestItem } from './x-agent-review-request-item'

const ctx: RenderContext = {
  sessionId: 'session-xyz',
  agentSlug: 'agent-xyz',
  readOnly: true,
}

const noop = () => {}

const cases: Array<{
  name: string
  descriptor: PendingRequestDescriptor
  expectedComponent: unknown
  expectedProps: Record<string, unknown>
}> = [
  {
    name: 'secret',
    descriptor: {
      kind: 'secret',
      key: 'k1',
      toolUseId: 'tu1',
      secretName: 'OPENAI_KEY',
      reason: 'Need it',
      onComplete: noop,
    },
    expectedComponent: SecretRequestItem,
    expectedProps: { toolUseId: 'tu1', secretName: 'OPENAI_KEY', reason: 'Need it' },
  },
  {
    name: 'connected_account',
    descriptor: {
      kind: 'connected_account',
      key: 'k2',
      toolUseId: 'tu2',
      toolkit: 'slack',
      reason: 'For DM',
      onComplete: noop,
    },
    expectedComponent: ConnectedAccountRequestItem,
    expectedProps: { toolUseId: 'tu2', toolkit: 'slack', reason: 'For DM' },
  },
  {
    name: 'remote_mcp',
    descriptor: {
      kind: 'remote_mcp',
      key: 'k3',
      toolUseId: 'tu3',
      url: 'https://mcp.test',
      name: 'Test',
      reason: 'why',
      authHint: 'oauth',
      onComplete: noop,
    },
    expectedComponent: RemoteMcpRequestItem,
    expectedProps: { toolUseId: 'tu3', url: 'https://mcp.test', name: 'Test', authHint: 'oauth' },
  },
  {
    name: 'question',
    descriptor: {
      kind: 'question',
      key: 'k4',
      toolUseId: 'tu4',
      questions: [
        { question: 'q?', header: 'h', options: [{ label: 'A', description: 'a' }], multiSelect: false },
      ],
      onComplete: noop,
    },
    expectedComponent: QuestionRequestItem,
    expectedProps: { toolUseId: 'tu4' },
  },
  {
    name: 'file',
    descriptor: {
      kind: 'file',
      key: 'k5',
      toolUseId: 'tu5',
      description: 'pick',
      fileTypes: '.pdf',
      onComplete: noop,
    },
    expectedComponent: FileRequestItem,
    expectedProps: { toolUseId: 'tu5', description: 'pick', fileTypes: '.pdf' },
  },
  {
    name: 'browser_input',
    descriptor: {
      kind: 'browser_input',
      key: 'k6',
      toolUseId: 'tu6',
      message: 'fill form',
      requirements: ['name', 'email'],
      onComplete: noop,
    },
    expectedComponent: BrowserInputRequestItem,
    expectedProps: { toolUseId: 'tu6', message: 'fill form', requirements: ['name', 'email'] },
  },
  {
    name: 'script_run',
    descriptor: {
      kind: 'script_run',
      key: 'k7',
      toolUseId: 'tu7',
      script: 'echo hi',
      explanation: 'say hi',
      scriptType: 'shell',
      onComplete: noop,
    },
    expectedComponent: ScriptRunRequestItem,
    expectedProps: { toolUseId: 'tu7', script: 'echo hi', explanation: 'say hi', scriptType: 'shell' },
  },
  {
    name: 'computer_use',
    descriptor: {
      kind: 'computer_use',
      key: 'k8',
      toolUseId: 'tu8',
      method: 'click',
      params: { x: 10 },
      permissionLevel: 'high',
      appName: 'Finder',
      onComplete: noop,
    },
    expectedComponent: ComputerUseRequestItem,
    expectedProps: { toolUseId: 'tu8', method: 'click', params: { x: 10 }, permissionLevel: 'high', appName: 'Finder' },
  },
  {
    name: 'proxy_review',
    descriptor: {
      kind: 'proxy_review',
      key: 'k9',
      reviewId: 'r1',
      accountId: 'a1',
      toolkit: 'gh',
      method: 'POST',
      targetPath: '/repos',
      matchedScopes: ['repo'],
      scopeDescriptions: { repo: 'Repos' },
      displayText: 'Push',
      onComplete: noop,
    },
    expectedComponent: ProxyReviewRequestItem,
    expectedProps: { reviewId: 'r1', accountId: 'a1', toolkit: 'gh', method: 'POST', targetPath: '/repos', displayText: 'Push' },
  },
  {
    name: 'x_agent_review',
    descriptor: {
      kind: 'x_agent_review',
      key: 'k10',
      reviewId: 'rx',
      xAgent: { targetAgentSlug: 'r', targetAgentName: 'R', operation: 'invoke' },
      onComplete: noop,
    },
    expectedComponent: XAgentReviewRequestItem,
    expectedProps: { reviewId: 'rx', xAgent: { targetAgentSlug: 'r', targetAgentName: 'R', operation: 'invoke' } },
  },
]

describe('renderPendingRequest', () => {
  for (const c of cases) {
    it(`renders the right component and props for kind=${c.name}`, () => {
      const el = renderPendingRequest(c.descriptor, ctx)
      expect(el.type).toBe(c.expectedComponent)

      const props = el.props as Record<string, unknown>
      for (const [k, v] of Object.entries(c.expectedProps)) {
        expect(props[k]).toEqual(v)
      }
      // Context is plumbed through on every kind.
      expect(props.agentSlug).toBe(ctx.agentSlug)
      expect(props.readOnly).toBe(ctx.readOnly)
      // sessionId is passed to all SSE-based items but NOT to proxy/x-agent reviews.
      if (c.name !== 'proxy_review' && c.name !== 'x_agent_review') {
        expect(props.sessionId).toBe(ctx.sessionId)
      }
      // Every descriptor's onComplete is forwarded as the onComplete prop.
      expect(props.onComplete).toBe(c.descriptor.onComplete)
      // The element's React key carries the descriptor key (for stable identity in lists).
      expect(el.key).toBe(c.descriptor.key)
    })
  }

  it('exhaustively covers every descriptor kind', () => {
    // If a new kind is added to PendingRequestDescriptor, the switch in
    // renderPendingRequest will fail to type-check (no return for the new
    // case). This sanity check pins the case count to the test table so we
    // remember to update it in lockstep.
    const kinds = new Set(cases.map((c) => c.descriptor.kind))
    expect(kinds.size).toBe(10)
  })
})
