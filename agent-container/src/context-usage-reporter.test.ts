import { describe, it, expect, vi } from 'vitest';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { ContextUsageReporter, contextUsageChange, type ContextUsageFrame } from './context-usage-reporter';

function summary(totalTokens: number, rawMaxTokens = 1_000_000): SDKControlGetContextUsageResponse {
  return { totalTokens, maxTokens: rawMaxTokens, rawMaxTokens } as SDKControlGetContextUsageResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('contextUsageChange', () => {
  it('marks turn ends and compactions settled', () => {
    expect(contextUsageChange({ type: 'result', subtype: 'success' })).toEqual({ settled: true });
    expect(contextUsageChange({ type: 'system', subtype: 'compact_boundary' })).toEqual({ settled: true });
  });

  it('marks a main-loop call and a query start mid-turn', () => {
    expect(contextUsageChange({ type: 'assistant', parent_tool_use_id: null })).toEqual({ settled: false });
    expect(contextUsageChange({ type: 'system', subtype: 'init' })).toEqual({ settled: false });
  });

  it('ignores subagent calls and frames that do not move the count', () => {
    expect(contextUsageChange({ type: 'assistant', parent_tool_use_id: 'toolu_1' })).toBeNull();
    expect(contextUsageChange({ type: 'stream_event' })).toBeNull();
    expect(contextUsageChange({ type: 'user' })).toBeNull();
    expect(contextUsageChange({ type: 'system', subtype: 'status' })).toBeNull();
  });
});

describe('ContextUsageReporter', () => {
  it('sends the CLI count against the auto-compact window', async () => {
    const sent: ContextUsageFrame[] = [];
    const reporter = new ContextUsageReporter(async () => summary(64_041), (frame) => sent.push(frame));

    reporter.refresh(true);
    await flush();

    expect(sent).toEqual([{ type: 'context_usage', totalTokens: 64_041, contextWindow: 1_000_000, settled: true }]);
  });

  it('runs one read at a time and one more for a burst during it, keeping settled', async () => {
    const first = deferred<SDKControlGetContextUsageResponse>();
    const reads = [first.promise, Promise.resolve(summary(32_166))];
    const read = vi.fn(() => reads.shift()!);
    const sent: ContextUsageFrame[] = [];
    const reporter = new ContextUsageReporter(read, (frame) => sent.push(frame));

    reporter.refresh(false);
    reporter.refresh(false);
    reporter.refresh(true);
    reporter.refresh(false);
    expect(read).toHaveBeenCalledTimes(1);

    first.resolve(summary(16_830));
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([
      { type: 'context_usage', totalTokens: 16_830, contextWindow: 1_000_000, settled: false },
      { type: 'context_usage', totalTokens: 32_166, contextWindow: 1_000_000, settled: true },
    ]);
  });

  it('sends nothing without a query, and keeps working after a failed read', async () => {
    const reads: Array<() => Promise<SDKControlGetContextUsageResponse | undefined>> = [
      async () => undefined,
      async () => { throw new Error('query closed'); },
      async () => summary(2_717),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: ContextUsageFrame[] = [];
    const reporter = new ContextUsageReporter(() => reads.shift()!(), (frame) => sent.push(frame));

    for (let i = 0; i < 3; i++) {
      reporter.refresh(true);
      await flush();
    }

    expect(sent).toEqual([{ type: 'context_usage', totalTokens: 2_717, contextWindow: 1_000_000, settled: true }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
