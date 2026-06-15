/**
 * Guard test: the Claude Agent SDK's streaming-input `Query` exposes the
 * `cancelAsyncMessage(uuid)` method that ClaudeCodeProcess.cancelQueuedMessage
 * relies on to drop a queued (not-yet-executed) message from the CLI command
 * queue.
 *
 * This is a sanctioned-but-untyped protocol feature — announced in the Agent
 * SDK changelog (v0.2.76: "Added `cancel_async_message` control subtype to drop
 * a queued user message by UUID before execution") with an exported wire type
 * `SDKControlCancelAsyncMessageRequest`, but the convenience method is omitted
 * from the public `Query` typings. Because it isn't in the types, a rename or
 * removal in an SDK upgrade would NOT be caught at compile time — it would
 * silently degrade every queued-message cancel to a no-op ("already picked up").
 * This test fails loudly instead, so the regression is obvious on bump.
 *
 * The method exists on the Query object as soon as `query()` returns (no API
 * round-trip needed), so this runs in CI without an API key. We never consume
 * the iterator, so no model request is made; we abort immediately to clean up.
 */
import { describe, it, expect } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

describe('SDK queued-message cancel API', () => {
  it('exposes cancelAsyncMessage on the streaming-input Query', () => {
    const abortController = new AbortController()
    // A streaming-input query: prompt is an async iterable. We never pull from
    // it (so nothing is sent to the model) — we only need the Query wrapper.
    const q = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        // Intentionally yields nothing; aborted below.
      })(),
      options: {
        abortController,
        // No model/API call is triggered without consuming the iterator.
      },
    })

    try {
      expect(typeof (q as unknown as Record<string, unknown>).cancelAsyncMessage).toBe('function')
    } finally {
      abortController.abort()
      // The Query is an async generator; closing it releases any resources.
      void q.return?.(undefined).catch(() => {})
    }
  })
})
