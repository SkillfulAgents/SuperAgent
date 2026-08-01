import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AutopilotState } from './types';

/**
 * Autopilot gate for ask-the-user tools.
 *
 * While autopilot is ENGAGED, tools that park the session on a human
 * (questions, secrets, files, connected accounts, remote MCPs, browser
 * handoffs, script approvals) are denied with corrective feedback instead of
 * blocking: the user delegated the task end-to-end and is not there to answer,
 * so a parked request would just hang until the watchdog pauses the session.
 * The deny tells the agent to decide for itself, or to declare itself blocked
 * and end the turn — which the stop-review then escalates to the user.
 *
 * Two enforcement seams, both required:
 * - a PreToolUse hook for main-chain calls (the authoritative gate — under
 *   permissionMode 'bypassPermissions' canUseTool is shadowed for regular
 *   tools, only hook denies apply);
 * - a canUseTool check for calls PreToolUse hooks may not see (subagent tool
 *   calls, and AskUserQuestion whose parking lives in canUseTool itself).
 *
 * `off`, `requested` (preflight — asking is the point), and `paused` states
 * pass everything through untouched.
 */

/**
 * Hook matcher for the gated set. Deliberately excludes the non-blocking
 * user-input tools (schedule_*, deliver_*, search_*, engage_autopilot) AND
 * request_script_run — that one is the agent↔host mechanism for running host
 * scripts and auto-executes without any user involvement when the
 * use_host_shell permission is already granted (mirrors the host's
 * isBlockingUserInputToolName classification). When script approval IS needed,
 * the host auto-rejects it while engaged (with a transcript card) instead of
 * parking a card the absent user cannot answer.
 */
export const AUTOPILOT_GATED_INPUT_TOOLS_MATCHER =
  '^(AskUserQuestion|mcp__user-input__request_(?!script_run$).*)$';

export function isAutopilotGatedInputTool(toolName: string): boolean {
  if (toolName === 'AskUserQuestion') return true;
  return (
    toolName.startsWith('mcp__user-input__request_') &&
    toolName !== 'mcp__user-input__request_script_run'
  );
}

export function autopilotInputDeniedMessage(toolName: string): string {
  return (
    `${toolName} was not executed: this session is in autopilot mode. The user has delegated this task to you end-to-end and is not available to answer — requests for user input are rejected while autopilot is engaged. ` +
    `Use your best judgment and keep going: make the reasonable decision yourself and continue toward the declared success criteria. ` +
    `If you are absolutely unable to proceed without the user (missing credential, access you cannot obtain, or an irreversible decision only they can make), do not retry input tools — state plainly that you are blocked and exactly why, then end your turn. The reviewer will pause autopilot and bring the user in.`
  );
}

/**
 * Container-side copy of the approval-denied guidance (the container cannot
 * import host modules). Used by the capability gate when a review-tier
 * subagent/workflow launch fires while engaged. `action` is a short
 * capitalized noun phrase, e.g. "Launching this subagent".
 */
export function autopilotApprovalDeniedMessage(action: string): string {
  return (
    `${action} requires user approval, and this session is running in autopilot mode — the user has delegated the task and is not available to approve it. ` +
    `Find another way to accomplish the goal that does not need approval. ` +
    `If there is no viable alternative, do not retry the action — state plainly that you are blocked on user approval and on exactly what, then end your turn. The reviewer will pause autopilot and bring the user in.`
  );
}

/**
 * Rides along with every real user message while autopilot is REQUESTED. The
 * system-prompt preflight section alone is not enough: models lock onto the
 * concrete task in the user message and never act on a passive fragment
 * hundreds of lines up in the prompt (observed live across multiple sessions
 * and models — zero preflights ran on prompt placement alone). Proximity to
 * the task fixes it. Sent as a separate content block on the same SDK user
 * message, so it never appears in the host-side transcript the UI renders.
 */
export function autopilotPreflightReminder(): string {
  return (
    '<system-reminder>\n' +
    'Autopilot has been requested for this session. Before acting on the message above, run your autopilot preflight (see "Autopilot — Preflight" in your system prompt): verify you have everything needed to finish this task without the user — accounts connected, credentials present, permissions sufficient, scope unambiguous — and ask any clarifying questions now. ' +
    'When ready, call the mcp__user-input__engage_autopilot tool with your goal contract; if it is not among your loaded tools, load it first with ToolSearch("select:mcp__user-input__engage_autopilot"). ' +
    'If nothing is missing, engage immediately and then start the work — do not skip engagement and do not wait for further permission.\n' +
    '</system-reminder>'
  );
}

export function createAutopilotInputGateHook(
  getAutopilotState: () => AutopilotState | undefined
): HookCallback {
  return async (input) => {
    if (getAutopilotState() !== 'engaged') return {};
    const toolName = (input as { tool_name?: string }).tool_name ?? 'This tool';
    // The predicate is the source of truth — a matcher/predicate drift must
    // fail open here (backstops still apply), never deny a non-gated tool.
    if (!isAutopilotGatedInputTool(toolName)) return {};
    console.log(`[PreToolUse] Denying ${toolName} (autopilot engaged)`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: autopilotInputDeniedMessage(toolName),
      },
    };
  };
}
