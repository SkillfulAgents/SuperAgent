import type { XAgentReview } from '@shared/lib/proxy/x-agent-review'
import type { ProxyReviewType } from '@shared/lib/proxy/review-display'

export type Question = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

export type PendingRequestDescriptor =
  | { kind: 'secret'; key: string; toolUseId: string; secretName: string; reason?: string; serviceName?: string; showAsConnection?: boolean; onComplete: () => void }
  | { kind: 'connected_account'; key: string; toolUseId: string; toolkit: string; reason?: string; onComplete: () => void }
  | { kind: 'remote_mcp'; key: string; toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer'; clientId?: string; clientName?: string; onComplete: () => void }
  | { kind: 'question'; key: string; toolUseId: string; questions: Question[]; onComplete: () => void }
  | { kind: 'file'; key: string; toolUseId: string; description: string; fileTypes?: string; onComplete: () => void }
  | { kind: 'browser_input'; key: string; toolUseId: string; message: string; requirements: string[]; onComplete: () => void }
  | { kind: 'script_run'; key: string; toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell'; onComplete: () => void }
  | { kind: 'computer_use'; key: string; toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; onComplete: () => void }
  | { kind: 'capability_review'; key: string; toolUseId: string; capability: 'subagents' | 'workflows'; toolName: string; input: Record<string, unknown>; onComplete: () => void }
  | { kind: 'proxy_review'; key: string; reviewId: string; accountId: string; reviewType?: ProxyReviewType; toolkit: string; method: string; targetPath: string; matchedScopes: string[]; scopeDescriptions: Record<string, string>; displayText?: string; onComplete: () => void }
  | { kind: 'x_agent_review'; key: string; reviewId: string; xAgent: XAgentReview; onComplete: () => void }
  | { kind: 'account_reauth_required'; key: string; proxyRequestId: string; accountId: string; toolkit: string; accountStatus: 'expired' | 'revoked'; onComplete: () => void }
  | { kind: 'mcp_reauth_required'; key: string; proxyRequestId: string; mcpId: string; mcpName: string; authType: 'none' | 'oauth' | 'bearer'; onComplete: () => void }
