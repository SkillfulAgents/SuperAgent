import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { inputManager, HUMAN_INPUT_TTL_MS } from './input-manager';
import type { AgentCapabilityPolicies } from './types';
import {
  blockedCapabilityMessage,
  capabilityGateFor,
  parseReviewDecisionScope,
  reviewDeclinedMessage,
  type Capability,
} from './capability-policies';

// The CLI enforces a per-hook timeout on SDK hook callbacks — 10 minutes when
// the matcher config carries none. A parked review must outlive that: an
// unattended session (scheduled run) legitimately waits hours for its human.
// One hour past the input-manager's human TTL so the TTL sweep always rejects
// first — the model then sees reviewDeclinedMessage instead of the CLI's
// generic "user doesn't want to take this action" synthesized on hook abort.
// Unit is SECONDS (HookCallbackMatcher.timeout), not ms.
export const CAPABILITY_REVIEW_HOOK_TIMEOUT_S = HUMAN_INPUT_TTL_MS / 1000 + 60 * 60;

export const REVIEW_CANCELLED_REASON = 'The approval request was cancelled before anyone decided';

export interface CapabilityGateContext {
  sessionId: string;
  getPolicies: () => AgentCapabilityPolicies | undefined;
  getSessionGrants: () => ReadonlySet<Capability>;
  onSessionGrant: (capability: Capability) => void;
  // The CLI stopped waiting for this hook (its timeout elapsed, or the turn
  // was aborted/interrupted) — the pending review is already rejected; the
  // host must close the approval card nobody can answer anymore.
  onReviewCancelled: (toolUseId: string, capability: Capability) => void;
}

/**
 * Three-tier launch policy gate for subagents (Task/Agent) and workflows
 * (Workflow). This MUST be a PreToolUse hook, not a canUseTool branch: under
 * permissionMode 'bypassPermissions' the SDK auto-approves every regular tool
 * call before canUseTool is consulted (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) —
 * only hook denies still apply. Review parks the launch on a pending input
 * (same round-trip as AskUserQuestion): the host renders the approval card and
 * answers via /inputs/:toolUseId/resolve|reject. Block is enforced at query
 * creation (tools stripped); the deny here is the backstop for a policy that
 * tightened mid-session.
 */
export function createCapabilityGateHook(ctx: CapabilityGateContext): HookCallback {
  return async (input, toolUseId, { signal }) => {
    const hookToolName = (input as { tool_name?: string }).tool_name;
    const gate = capabilityGateFor(hookToolName ?? '', ctx.getPolicies(), ctx.getSessionGrants());
    if (!gate) return {};
    if (gate.policy === 'block') {
      console.log(`[PreToolUse] Denying ${hookToolName} (${gate.capability} blocked)`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: blockedCapabilityMessage(gate.capability),
        },
      };
    }

    const requestId = toolUseId || `capability-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    console.log(`[PreToolUse] Capability review for ${hookToolName} (${gate.capability}), toolUseId: ${requestId}`);
    // When the CLI abandons this hook it sends a control_cancel_request and
    // this signal fires. Without the listener the pending entry parks as a
    // zombie until the 24h TTL and the host keeps a card nobody is waiting on.
    const onAbort = () => {
      inputManager.reject(requestId, REVIEW_CANCELLED_REASON);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      // Park until the user decides via the approval card
      const decision = await inputManager.createPendingWithType<Record<string, string>>(
        requestId,
        'capability_review',
        { capability: gate.capability, toolName: hookToolName },
        ctx.sessionId
      );
      if (parseReviewDecisionScope(decision) === 'session') {
        console.log(`[PreToolUse] Session-scoped grant for ${gate.capability}`);
        ctx.onSessionGrant(gate.capability);
      }
      return {};
    } catch (error) {
      console.log(`[PreToolUse] Capability launch declined:`, error);
      if (signal.aborted) {
        ctx.onReviewCancelled(requestId, gate.capability);
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reviewDeclinedMessage(
            gate.capability,
            error instanceof Error ? error.message : undefined
          ),
        },
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}
