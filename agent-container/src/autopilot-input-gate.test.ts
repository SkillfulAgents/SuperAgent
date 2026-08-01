import { describe, it, expect } from 'vitest';
import {
  AUTOPILOT_GATED_INPUT_TOOLS_MATCHER,
  autopilotInputDeniedMessage,
  createAutopilotInputGateHook,
  isAutopilotGatedInputTool,
} from './autopilot-input-gate';
import type { AutopilotState } from './types';

const GATED = [
  'AskUserQuestion',
  'mcp__user-input__request_secret',
  'mcp__user-input__request_connected_account',
  'mcp__user-input__request_file',
  'mcp__user-input__request_remote_mcp',
  'mcp__user-input__request_browser_input',
];

// Non-blocking user-input tools and everything else must pass through — most
// importantly engage_autopilot itself (shares the server prefix) and
// request_script_run (auto-executes against a cached use_host_shell grant;
// it is the agent↔host script channel, not reliably a user ask — same
// exclusion as the host's isBlockingUserInputToolName).
const NOT_GATED = [
  'mcp__user-input__engage_autopilot',
  'mcp__user-input__request_script_run',
  'mcp__user-input__schedule_task',
  'mcp__user-input__schedule_resume',
  'mcp__user-input__deliver_file',
  'mcp__user-input__search_connected_account_services',
  'mcp__browser__browser_open',
  'Bash',
  'Task',
];

async function runHook(state: AutopilotState | undefined, toolName: string) {
  const hook = createAutopilotInputGateHook(() => state);
  return hook(
    { tool_name: toolName } as never,
    'tool-use-1',
    { signal: new AbortController().signal } as never
  );
}

function isDeny(result: unknown): boolean {
  const out = (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
  return out?.permissionDecision === 'deny';
}

describe('autopilot input gate', () => {
  it('classifies exactly the blocking ask-the-user tools as gated', () => {
    for (const name of GATED) {
      expect(isAutopilotGatedInputTool(name), name).toBe(true);
    }
    for (const name of NOT_GATED) {
      expect(isAutopilotGatedInputTool(name), name).toBe(false);
    }
  });

  it('the hook matcher regex agrees with the predicate', () => {
    const matcher = new RegExp(AUTOPILOT_GATED_INPUT_TOOLS_MATCHER);
    for (const name of GATED) {
      expect(matcher.test(name), name).toBe(true);
    }
    for (const name of NOT_GATED) {
      expect(matcher.test(name), name).toBe(false);
    }
  });

  it('denies gated tools while engaged, with corrective guidance', async () => {
    const result = await runHook('engaged', 'mcp__user-input__request_secret');
    expect(isDeny(result)).toBe(true);
    const reason = (result as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('autopilot');
    expect(reason).toContain('best judgment');
    expect(reason).toContain('blocked');
  });

  it('allows request_script_run even while engaged (hook fails open on non-gated tools)', async () => {
    const result = await runHook('engaged', 'mcp__user-input__request_script_run');
    expect(result).toEqual({});
  });

  it('passes everything through in every non-engaged state', async () => {
    for (const state of ['off', 'requested', 'paused', undefined] as const) {
      const result = await runHook(state, 'AskUserQuestion');
      expect(result).toEqual({});
    }
  });

  it('reads the state live — an engagement mid-query flips the gate on', async () => {
    let state: AutopilotState = 'requested';
    const hook = createAutopilotInputGateHook(() => state);
    const before = await hook(
      { tool_name: 'AskUserQuestion' } as never,
      't1',
      { signal: new AbortController().signal } as never
    );
    expect(before).toEqual({});

    state = 'engaged';
    const after = await hook(
      { tool_name: 'AskUserQuestion' } as never,
      't2',
      { signal: new AbortController().signal } as never
    );
    expect(isDeny(after)).toBe(true);
  });

  it('the denial message names the rejected tool', () => {
    expect(autopilotInputDeniedMessage('AskUserQuestion')).toMatch(/^AskUserQuestion was not executed/);
  });
});
