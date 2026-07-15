import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  ContainerSession,
  ContainerStats,
  CreateSessionOptions,
  StartOptions,
  StopOptions,
  StreamMessage,
} from './types'
import type { RuntimeOptions } from './runtime-options'
import { resolveContainerModel } from './resolve-model'
import { getSessionJsonlPath } from '../utils/file-storage'
import { reviewManager } from '../proxy/review-manager'
import { db } from '../db'
import { connectedAccounts } from '../db/schema'

export const MOCK_ACCOUNT_ID = 'mock-account-id'

// E2E mock scenarios reference a fake connected account by id. The
// /proxy-review/.../always endpoint persists an apiScopePolicies row whose
// account_id has a FK on connected_accounts; without this seed the insert
// fails and the route returns 500, breaking the "always allow" test.
//
// The account id is parameterizable so a spec can pass a per-test id
// (`proxy review account_id=<uuid>`). apiScopePolicies is keyed by
// (accountId, scope), so tests that persist "always" decisions must each own a
// distinct account or they race on the shared MOCK_ACCOUNT_ID rows across the
// 6 workers. The toolkit stays 'slack' so 'chat:write' remains a valid scope.
const seededMockAccounts = new Set<string>()
async function seedMockConnectedAccount(accountId: string = MOCK_ACCOUNT_ID): Promise<void> {
  if (seededMockAccounts.has(accountId)) return
  const now = new Date()
  await db.insert(connectedAccounts).values({
    id: accountId,
    providerConnectionId: accountId,
    providerName: 'composio',
    toolkitSlug: 'slack',
    displayName: 'Mock Account',
    status: 'active',
    userId: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing()
  seededMockAccounts.add(accountId)
}

/**
 * Mock scenario interface for simulating different response patterns
 */
export interface MockScenario {
  execute(
    sessionId: string,
    client: MockContainerClient,
    userMessage: string
  ): void
}

/**
 * Simple text response scenario - streams text in chunks
 * Event format matches what MessagePersister expects from the real container
 */
export class SimpleTextResponseScenario implements MockScenario {
  constructor(private responseText: string) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const words = this.responseText.split(' ')
    const finalDelay = 60 + words.length * 5

    // Start assistant message - wrapped in stream_event
    // The content needs a 'type' field that MessagePersister.handleMessage switches on
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, 10)

    // Stream content block start - text block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, 20)

    // Stream text in chunks
    words.forEach((word, i) => {
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (i > 0 ? ' ' : '') + word } } },
        })
      }, 30 + i * 5)
    })

    // End content block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, 40 + words.length * 5)

    // End message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, 50 + words.length * 5)

    // Write JSONL entries before sending result
    setTimeout(() => {
      // Write user message
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })

      // Write assistant message
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: this.responseText }] },
        timestamp: new Date().toISOString(),
      })

      // Then mark session as done (idle) - result event
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'success' },
      })
    }, finalDelay)
  }
}

/**
 * Extended-thinking scenario — streams a thinking block (content_block_start
 * type:'thinking' + thinking_delta chunks) before the text response, so E2E
 * tests can exercise the thinking card in the transcript: expanded while
 * streaming, collapsed to a "Thought for Ns" header once the block stops.
 */
export class ThinkingResponseScenario implements MockScenario {
  constructor(
    private thinkingText: string,
    private responseText: string,
    /** Delay between thinking chunks — sets how long the card stays live. */
    private chunkDelayMs = 200
  ) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const chunks = this.thinkingText.split(' ')

    setTimeout(() => {
      // Written up front (like the real CLI) so the read-path can derive the
      // thinking duration from the user→assistant entry timestamp gap.
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
      })
    }, 10)

    chunks.forEach((word, i) => {
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: (i > 0 ? ' ' : '') + word } } },
        })
      }, 20 + i * this.chunkDelayMs)
    })

    const thinkingDone = 30 + chunks.length * this.chunkDelayMs
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: this.responseText } } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, thinkingDone)

    setTimeout(() => {
      // The real CLI persists the thinking block in the transcript (CLI 2.1.181+),
      // which the messages read-path extracts into ApiMessage.thinking.
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: this.thinkingText, signature: 'mock-signature' },
            { type: 'text', text: this.responseText },
          ],
        },
        timestamp: new Date().toISOString(),
      })
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'success' },
      })
    }, thinkingDone + 50)
  }
}

/**
 * Slow scenario for message-queueing E2E tests: holds the session in the
 * working state long enough for the test to send mid-turn messages, which the
 * mock records as queued_command attachments (mirroring the real CLI's
 * steering behavior — see the busy path in sendMessage).
 */
export class SlowWorkScenario implements MockScenario {
  constructor(private durationMs = 5000) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    setTimeout(() => {
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })
      // Echo on the stream so the host broadcasts messages_updated and the
      // frontend materializes the turn-starting ghost while still working
      client.emitStreamMessage(sessionId, {
        type: 'user',
        content: { type: 'user', message: { content: [{ type: 'text', text: userMessage }] } },
      })
    }, 10)

    // Open a streaming text block so the UI shows live activity for the
    // whole window
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working on the slow task...' } } },
      })
    }, 50)

    setTimeout(() => {
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Finished the slow work.' }] },
        timestamp: new Date().toISOString(),
      })
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'success' },
      })
    }, this.durationMs)
  }
}

/**
 * API error scenario - simulates an LLM provider error (e.g., auth failure, rate limit).
 * Emits an assistant message with the SDK error code, then a result with error subtype.
 */
export class ApiErrorScenario implements MockScenario {
  constructor(
    private errorCode: string,
    private errorMessage: string
  ) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    // Write user message
    setTimeout(() => {
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })
    }, 10)

    // Write assistant message with error field (SDK sets this on API failures)
    setTimeout(() => {
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: this.errorMessage }] },
        error: this.errorCode,
        timestamp: new Date().toISOString(),
      })

      // Emit the assistant message through the stream (with error code)
      client.emitStreamMessage(sessionId, {
        type: 'assistant',
        content: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: this.errorMessage }] },
          error: this.errorCode,
        },
      })
    }, 20)

    // Emit error result
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: {
          type: 'result',
          subtype: 'error_during_execution',
          error: this.errorMessage,
          is_error: true,
          errors: [this.errorMessage],
        },
      })
    }, 40)
  }
}

/**
 * Delayed text response scenario - adds an initial delay before responding.
 * Useful for E2E tests that need the agent to stay "working" for a while.
 */
export class DelayedTextResponseScenario implements MockScenario {
  constructor(private responseText: string, private delayMs: number) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const inner = new SimpleTextResponseScenario(this.responseText)
    // Write user message immediately so it's visible, delay the response
    setTimeout(() => {
      inner.execute(sessionId, client, userMessage)
    }, this.delayMs)
  }
}

/**
 * Tool use scenario - simulates a tool call with result
 * Event format matches what MessagePersister expects from the real container
 */
export class ToolUseScenario implements MockScenario {
  constructor(
    private toolName: string,
    private toolInput: Record<string, unknown>,
    private toolResult: string,
    private finalText: string
  ) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    let delay = 10
    const toolId = `tool_${Date.now()}`

    // Start assistant message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 10

    // Tool use start
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: this.toolName,
            },
          },
        },
      })
    }, delay)
    delay += 10

    // Tool input delta
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(this.toolInput),
            },
          },
        },
      })
    }, delay)
    delay += 20

    // Tool use stop
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 10

    // Tool result comes as a 'user' type message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'user',
        content: {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: toolId,
              content: this.toolResult,
            }],
          },
        },
      })
    }, delay)
    delay += 20

    // Final text response - new text block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, delay)
    delay += 10

    const words = this.finalText.split(' ')
    words.forEach((word, i) => {
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (i > 0 ? ' ' : '') + word } } },
        })
      }, delay + i * 5)
    })
    delay += words.length * 5 + 10

    // End content block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 10

    // End message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 10

    // Write JSONL entries before sending result
    const finalDelay = delay
    setTimeout(() => {
      // Write user message
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })

      // Write assistant message with tool use
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: toolId, name: this.toolName, input: this.toolInput },
            { type: 'text', text: this.finalText },
          ],
        },
        timestamp: new Date().toISOString(),
      })

      // Write tool result as user message
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: toolId, content: this.toolResult },
          ],
        },
        timestamp: new Date().toISOString(),
      })

      // Mark session as done (idle)
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'success' },
      })
    }, finalDelay)
  }
}

/**
 * User input request scenario - simulates the agent emitting tool calls that
 * request user input (secrets, questions, etc.). The session stays active until
 * all inputs are resolved/rejected via fetch().
 */
type UserInputToolInput = Record<string, unknown> | ((userMessage: string) => Record<string, unknown>)

export interface UserInputTool {
  name: string
  input: UserInputToolInput
}

export class UserInputRequestScenario implements MockScenario {
  constructor(private tools: UserInputTool[]) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    let delay = 10
    const tools = this.tools.map((tool) => ({
      name: tool.name,
      input: typeof tool.input === 'function' ? tool.input(userMessage) : tool.input,
    }))
    const toolIds: string[] = []

    // Pre-generate tool IDs so we can register pending inputs immediately
    for (let i = 0; i < tools.length; i++) {
      toolIds.push(`tool_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`)
    }

    // Register pending inputs BEFORE emitting any events, so that
    // resolve/reject calls from the API can find and decrement the count.
    client.registerPendingInputs(sessionId, tools.length)

    // Write the user message entry immediately so the JSONL file exists on disk.
    // The backend's getSession() checks fileExists(jsonlPath) and returns 404 if
    // missing — without this, a fast deny/resolve can race the delayed write below.
    client.writeJsonlEntry(sessionId, {
      type: 'user',
      message: { content: userMessage },
      timestamp: new Date().toISOString(),
    })

    // Start assistant message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 10

    // Emit each tool use block
    for (let toolIndex = 0; toolIndex < tools.length; toolIndex++) {
      const tool = tools[toolIndex]
      const capturedToolId = toolIds[toolIndex]
      const capturedTool = tool
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: {
                type: 'tool_use',
                id: capturedToolId,
                name: capturedTool.name,
              },
            },
          },
        })
      }, delay)
      delay += 10

      // content_block_delta (input_json_delta)
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(capturedTool.input),
              },
            },
          },
        })
      }, delay)
      delay += 10

      // content_block_stop — triggers MessagePersister to detect user input tools
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_stop' } },
        })
      }, delay)
      delay += 50
    }

    // message_stop
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 10

    // Write assistant JSONL entry after streaming completes (user message was
    // already written synchronously above so the file exists on disk).
    const capturedToolIds = [...toolIds]
    const capturedTools = [...tools]
    const finalDelay = delay
    setTimeout(() => {
      const assistantContent = capturedTools.map((tool, i) => ({
        type: 'tool_use',
        id: capturedToolIds[i],
        name: tool.name,
        input: tool.input,
      }))
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: { content: assistantContent },
        timestamp: new Date().toISOString(),
      })
      // Emit the completed assistant message through the stream so MessagePersister
      // broadcasts `messages_updated` (the real Claude Agent SDK emits this; a direct
      // JSONL write alone does not). Without it, a client that joined after the
      // one-shot `*_request` broadcasts has NO signal to refetch the transcript and
      // recover the pending input cards — it would hang until the safety-net poll,
      // which is the e2e flake on slow CI (user-input-requests parallel cases).
      client.emitStreamMessage(sessionId, {
        type: 'assistant',
        content: { type: 'assistant', message: { content: assistantContent } },
      })
    }, finalDelay)
  }
}

function getMessageParam(userMessage: string, key: string): string | undefined {
  const prefix = `${key}=`
  const rawValue = userMessage
    .split(/\s+/)
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length)

  if (!rawValue) return undefined

  try {
    return decodeURIComponent(rawValue)
  } catch {
    return rawValue
  }
}

function connectedAccountRequestInput(userMessage: string): Record<string, unknown> {
  return {
    toolkit: getMessageParam(userMessage, 'account_toolkit') ?? 'github',
    reason: getMessageParam(userMessage, 'account_reason') ?? 'Need access to your GitHub repositories',
  }
}

function remoteMcpRequestInput(userMessage: string): Record<string, unknown> {
  return {
    url: getMessageParam(userMessage, 'mcp_url') ?? 'http://localhost:9876/mcp',
    name: getMessageParam(userMessage, 'mcp_name') ?? 'Test MCP',
    reason: getMessageParam(userMessage, 'mcp_reason') ?? 'Need access to test tools',
  }
}

/**
 * Proxy review scenario - simulates the proxy holding an API request for user review.
 * Uses the real ReviewManager so that Allow/Deny buttons work end-to-end.
 */
export class ProxyReviewScenario implements MockScenario {
  constructor(
    private toolkit: string,
    private method: string,
    private targetPath: string,
    private matchedScopes: string[],
    private scopeDescriptions: Record<string, string>
  ) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const agentSlug = client.getAgentId()
    let delay = 10

    // Start streaming an assistant message first
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 10

    // Stream some text
    const text = `Making API call: ${this.method} ${this.targetPath}`
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 20

    // Now trigger the proxy review via ReviewManager. The account id is
    // parameterizable (`account_id=<uuid>`) so specs that persist "always"
    // policies each own a distinct account and don't race on the shared
    // MOCK_ACCOUNT_ID scope-policy rows across workers.
    const accountId = getMessageParam(userMessage, 'account_id') ?? MOCK_ACCOUNT_ID
    const capturedDelay = delay
    setTimeout(async () => {
      await seedMockConnectedAccount(accountId)
      // Fire-and-forget — the promise resolves when the user decides
      reviewManager.requestReview({
        agentSlug,
        accountId,
        toolkit: this.toolkit,
        method: this.method,
        targetPath: this.targetPath,
        matchedScopes: this.matchedScopes,
        scopeDescriptions: this.scopeDescriptions,
      }).then((decision) => {
        // Write JSONL and complete the session after the user decides
        client.writeJsonlEntry(sessionId, {
          type: 'user',
          message: { content: userMessage },
          timestamp: new Date().toISOString(),
        })
        client.writeJsonlEntry(sessionId, {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `API request ${decision === 'allow' ? 'approved' : 'denied'} by user.` }] },
          timestamp: new Date().toISOString(),
        })
        client.emitStreamMessage(sessionId, {
          type: 'result',
          content: { type: 'result', subtype: 'success' },
        })
      }).catch(() => {
        // Timeout or rejection — complete the session anyway
        client.emitStreamMessage(sessionId, {
          type: 'result',
          content: { type: 'result', subtype: 'success' },
        })
      })
    }, capturedDelay)
  }
}

export class XAgentReviewScenario implements MockScenario {
  constructor(
    private targetAgentSlug: string,
    private targetAgentName: string,
    private operation: 'list' | 'read' | 'invoke' | 'create',
  ) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const agentSlug = client.getAgentId()
    let delay = 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 10

    const text = `Requesting x-agent ${this.operation} on ${this.targetAgentName}`
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 20

    const capturedDelay = delay
    setTimeout(() => {
      reviewManager.requestXAgentReview(
        agentSlug,
        this.targetAgentSlug,
        this.targetAgentName,
        this.operation,
      ).then((decision) => {
        client.writeJsonlEntry(sessionId, {
          type: 'user',
          message: { content: userMessage },
          timestamp: new Date().toISOString(),
        })
        client.writeJsonlEntry(sessionId, {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `X-agent ${this.operation} ${decision === 'allow' ? 'approved' : 'denied'} by user.` }] },
          timestamp: new Date().toISOString(),
        })
        client.emitStreamMessage(sessionId, {
          type: 'result',
          content: { type: 'result', subtype: 'success' },
        })
      }).catch(() => {
        client.emitStreamMessage(sessionId, {
          type: 'result',
          content: { type: 'result', subtype: 'success' },
        })
      })
    }, capturedDelay)
  }
}

/**
 * Background Bash scenario — simulates a Bash tool call with run_in_background: true.
 * The SDK returns an immediate tool result with backgroundTaskId, the agent finishes
 * its turn, then after a delay a task-notification arrives and the agent responds.
 */
export class BackgroundBashScenario implements MockScenario {
  constructor(
    private delayMs: number = 2000,
    private commandOutput: string = 'done sleeping',
  ) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    let delay = 10
    const toolId = `tool_bash_${Date.now()}`
    const bgTaskId = `bg_${Date.now().toString(36)}`

    // Start assistant message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 10

    // Tool use start: Bash
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: toolId, name: 'Bash' },
          },
        },
      })
    }, delay)
    delay += 10

    // Tool input delta
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'sleep 10 && echo done', run_in_background: true }) },
          },
        },
      })
    }, delay)
    delay += 20

    // Tool use stop
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 10

    // Tool result with backgroundTaskId
    setTimeout(() => {
      client.registerBackgroundTask(sessionId, bgTaskId)
      client.emitStreamMessage(sessionId, {
        type: 'user',
        content: {
          type: 'user',
          tool_use_result: { backgroundTaskId: bgTaskId, stdout: '', stderr: '', interrupted: false, isImage: false },
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: toolId,
              content: `Command running in background with ID: ${bgTaskId}. Output is being written to: /tmp/tasks/${bgTaskId}.output.`,
            }],
          },
        },
      })
    }, delay)
    delay += 20

    // Agent streams a text response
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, delay)
    delay += 10

    const responseText = `Started background task ${bgTaskId}.`
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: responseText } } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 10

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 10

    // Write JSONL and emit result (agent turn ends, but bg task is still running)
    const firstResultDelay = delay
    setTimeout(() => {
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: { content: [
          { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'sleep 10 && echo done', run_in_background: true } },
          { type: 'text', text: responseText },
        ] },
        timestamp: new Date().toISOString(),
      })
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        toolUseResult: { backgroundTaskId: bgTaskId, stdout: '', stderr: '', interrupted: false, isImage: false },
        message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: `Command running in background with ID: ${bgTaskId}.` }] },
        timestamp: new Date().toISOString(),
      })

      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'success' },
      })
    }, firstResultDelay)

    // After delay, the background command finishes. The SDK delivers the completion
    // as a `task_updated` state patch (the busy-path shape: the task settled while
    // the agent had moved on, so there is no in-band `task_notification` carrying this
    // task's id — only a state change). The persister clears the task from this.
    // See message-persister.ts `task_updated` handling and the
    // background-bash-busy-completion replay fixture.
    const notificationDelay = firstResultDelay + this.delayMs
    setTimeout(() => {
      client.completeBackgroundTask(sessionId, bgTaskId)
      client.emitStreamMessage(sessionId, {
        type: 'system',
        content: {
          type: 'system',
          subtype: 'task_updated',
          task_id: bgTaskId,
          patch: { status: 'completed', end_time: Date.now() },
          session_id: sessionId,
        },
      })
    }, notificationDelay)

    // Agent processes the notification — reads the output and responds
    const finalDelay = notificationDelay + 50
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, finalDelay)

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, finalDelay + 10)

    const finalText = `Background command completed. Output: ${this.commandOutput}`
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: finalText } } },
      })
    }, finalDelay + 20)

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, finalDelay + 30)

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, finalDelay + 40)

    // Write JSONL and final result
    setTimeout(() => {
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { content: `<task-notification>\n<task-id>${bgTaskId}</task-id>\n<status>completed</status>\n</task-notification>` },
        timestamp: new Date().toISOString(),
      })
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: finalText }] },
        timestamp: new Date().toISOString(),
      })

      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'success' },
      })
    }, finalDelay + 50)
  }
}

/**
 * Mock implementation of ContainerClient for E2E testing.
 * Simulates container behavior without requiring Docker/Podman.
 */
// Browser scenario cleanup function — set by dynamic import below
let cleanupBrowserSessionFn: ((sessionId: string) => void) | null = null

// Register browser scenario only when E2E_CHROMIUM_PATH is available
if (process.env.E2E_MOCK === 'true' && process.env.E2E_CHROMIUM_PATH) {
  import('./mock-browser-scenario').then(({ BrowserScenario, cleanupBrowserSession }) => {
    MockContainerClient.scenarios.set('browse ', new BrowserScenario())
    cleanupBrowserSessionFn = cleanupBrowserSession
    console.log('[MockContainerClient] Registered BrowserScenario (E2E_CHROMIUM_PATH available)')
  })
}

export class MockContainerClient extends EventEmitter implements ContainerClient {
  // Global scenario registry - tests can register scenarios by message pattern
  static scenarios = new Map<string, MockScenario>([
    // Slow response window for message-queueing tests (send mid-turn → queued)
    ['work slowly', new SlowWorkScenario()],
    // Extended-thinking card in the transcript (expanded while streaming, then collapsed)
    ['think out loud', new ThinkingResponseScenario(
      'Let me reason about this. The user wants a demonstration of extended thinking, ' +
      'so I will stream a few sentences of summarized reasoning before replying.',
      'Done thinking — here is the answer.'
    )],
    // Register the "list files" scenario for tool use tests
    ['list files', new ToolUseScenario(
      'Bash',
      { command: 'ls -la' },
      'file1.txt\nfile2.txt\nfolder/',
      'I found the following files in the current directory.'
    )],
    // Register a background bash scenario for testing background task tracking
    ['run background', new BackgroundBashScenario(2000, 'done sleeping')],
    // Register a slow response scenario for cross-session tests
    ['slow response', new DelayedTextResponseScenario(
      'This is a delayed mock response.',
      3000
    )],
    // Register user input request scenarios for E2E testing
    ['ask secret', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_secret',
        input: { secretName: 'OPENAI_API_KEY', reason: 'Needed for API access' },
      },
    ])],
    ['ask question', new UserInputRequestScenario([
      {
        name: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Which database should we use?',
            header: 'Database',
            options: [
              { label: 'PostgreSQL', description: 'Reliable relational database' },
              { label: 'MongoDB', description: 'Flexible document store' },
              { label: 'SQLite', description: 'Lightweight embedded database' },
            ],
            multiSelect: false,
          }],
        },
      },
    ])],
    // Note: scenarios are matched by substring in insertion order, so
    // longer/more-specific triggers must come first to avoid being shadowed
    // by shorter prefixes.
    ['ask multi parallel', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_secret',
        input: { secretName: 'DATABASE_URL', reason: 'Connection string for the database' },
      },
      {
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which database should we use?',
              header: 'Database',
              options: [
                { label: 'PostgreSQL', description: 'Reliable relational database' },
                { label: 'MongoDB', description: 'Flexible document store' },
              ],
              multiSelect: false,
            },
            {
              question: 'Which cloud provider do you prefer?',
              header: 'Cloud',
              options: [
                { label: 'AWS', description: 'Amazon Web Services' },
                { label: 'GCP', description: 'Google Cloud Platform' },
              ],
              multiSelect: false,
            },
            {
              question: 'Preferred language?',
              header: 'Language',
              options: [
                { label: 'TypeScript', description: 'Typed JavaScript' },
                { label: 'Go', description: 'Compiled' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ])],
    ['ask multi', new UserInputRequestScenario([
      {
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which database should we use?',
              header: 'Database',
              options: [
                { label: 'PostgreSQL', description: 'Reliable relational database' },
                { label: 'MongoDB', description: 'Flexible document store' },
              ],
              multiSelect: false,
            },
            {
              question: 'Which cloud provider do you prefer?',
              header: 'Cloud',
              options: [
                { label: 'AWS', description: 'Amazon Web Services' },
                { label: 'GCP', description: 'Google Cloud Platform' },
              ],
              multiSelect: false,
            },
            {
              question: 'Preferred language?',
              header: 'Language',
              options: [
                { label: 'TypeScript', description: 'Typed JavaScript' },
                { label: 'Go', description: 'Compiled' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ])],
    // Script type must be valid for the host platform (VALID_SCRIPT_TYPES in
    // settings.ts) or the persister auto-rejects before the card ever pends.
    ['ask script', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_script_run',
        input: process.platform === 'win32'
          ? { script: 'Get-ComputerInfo', explanation: 'Check OS version', scriptType: 'powershell' }
          : { script: 'sw_vers', explanation: 'Check OS version', scriptType: 'shell' },
      },
    ])],
    ['use computer', new UserInputRequestScenario([
      {
        name: 'mcp__computer-use__computer_apps',
        input: { method: 'apps', params: {}, permissionLevel: 'list_apps_windows' },
      },
    ])],
    ['ask parallel', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_secret',
        input: { secretName: 'DATABASE_URL', reason: 'Connection string for the database' },
      },
      {
        name: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Which cloud provider do you prefer?',
            header: 'Cloud',
            options: [
              { label: 'AWS', description: 'Amazon Web Services' },
              { label: 'GCP', description: 'Google Cloud Platform' },
            ],
            multiSelect: false,
          }],
        },
      },
    ])],
    // Capability review scenarios: the streamed Task/Workflow tool_use flows
    // through the real MessagePersister policy gate (workflows default to
    // review, subagents to allow), and the decision route answers via the
    // mock's /inputs resolve/reject just like the real container.
    ['launch workflow', new UserInputRequestScenario([
      {
        name: 'Workflow',
        input: {
          name: 'sample-audit',
          script: [
            "export const meta = {",
            "  name: 'sample-audit',",
            "  description: 'Audit the sample data set',",
            "  phases: [",
            "    { title: 'Scan', detail: 'collect candidates' },",
            "    { title: 'Verify', detail: 'adversarially check each' },",
            "  ],",
            "}",
            "const found = await parallel([() => agent('scan part one'), () => agent('scan part two')])",
            "const verified = await agent('verify: ' + JSON.stringify(found))",
            "return verified",
          ].join('\n'),
        },
      },
    ])],
    ['launch subagent', new UserInputRequestScenario([
      {
        name: 'Task',
        input: { subagent_type: 'Explore', description: 'Scan the repo', prompt: 'Look at the files and report back' },
      },
    ])],
    // Proxy review scenario for E2E tests
    ['proxy review', new ProxyReviewScenario(
      'slack',
      'POST',
      'api/chat.postMessage',
      ['chat:write'],
      { 'chat:write': 'Send a message to a channel' }
    )],
    // X-agent review scenario for E2E tests
    ['x-agent review', new XAgentReviewScenario('helper-bot', 'Helper Bot', 'list')],
    // Tool rendering scenarios for E2E tests
    ['read file', new ToolUseScenario(
      'Read',
      { file_path: '/workspace/src/index.ts' },
      'const app = express();\napp.listen(3000);',
      'Here is the content of the file.'
    )],
    ['write file', new ToolUseScenario(
      'Write',
      { file_path: '/workspace/src/hello.ts', content: 'console.log("hello")' },
      'File written successfully.',
      'I created the file for you.'
    )],
    ['search code', new ToolUseScenario(
      'Grep',
      { pattern: 'TODO', include: '*.ts' },
      'src/index.ts:5: // TODO: add error handling\nsrc/utils.ts:12: // TODO: refactor',
      'I found 2 TODO comments in the codebase.'
    )],
    ['find files', new ToolUseScenario(
      'Glob',
      { pattern: 'src/**/*.ts' },
      'src/index.ts\nsrc/utils.ts\nsrc/types.ts',
      'I found 3 TypeScript files.'
    )],
    ['search web', new ToolUseScenario(
      'WebSearch',
      { query: 'TypeScript best practices 2025' },
      'Web search results for query: TypeScript best practices 2025\n\n1. Use strict mode\n2. Prefer interfaces over types',
      'Here are the search results.'
    )],
    // Connected account request scenario
    ['ask account', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_connected_account',
        input: connectedAccountRequestInput,
      },
    ])],
    // Remote MCP request scenario - tests can override inputs with mcp_url/name/reason message params.
    ['request mcp', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_remote_mcp',
        input: remoteMcpRequestInput,
      },
    ])],
    // File delivery scenario for E2E tests
    ['deliver file', new ToolUseScenario(
      'mcp__user-input__deliver_file',
      { filePath: '/workspace/output/report.md', description: 'Generated report' },
      'File delivered successfully (size: 150 bytes)',
      'I\'ve delivered the report for your review.'
    )],
    ['deliver image', new ToolUseScenario(
      'mcp__user-input__deliver_file',
      { filePath: '/workspace/output/chart.png', description: 'Sales chart' },
      'File delivered successfully (size: 2048 bytes)',
      'Here is the sales chart.'
    )],
    ['deliver csv', new ToolUseScenario(
      'mcp__user-input__deliver_file',
      { filePath: '/workspace/output/data.csv', description: 'Contacts export' },
      'File delivered successfully (size: 256 bytes)',
      'Here is the contacts export.'
    )],
    ['deliver video', new ToolUseScenario(
      'mcp__user-input__deliver_file',
      { filePath: '/workspace/output/clip.mp4', description: 'Demo clip' },
      'File delivered successfully (size: 4096 bytes)',
      'Here is the demo clip.'
    )],
    // API error scenarios
    ['auth error', new ApiErrorScenario('authentication_failed', 'Invalid API key')],
    ['rate limit error', new ApiErrorScenario('rate_limit', 'Rate limit exceeded, please try again later')],
    // Schedule resume (session long-sleep) scenario — the host interceptor
    // persists a real wake row targeting this session, so E2E can exercise the
    // pending-wake banner, sidebar badge, and Wake now / Cancel actions.
    ['schedule resume', new ToolUseScenario(
      'mcp__user-input__schedule_resume',
      {
        wakeTime: 'at now + 2 hours',
        note: 'Check whether the review has been approved',
      },
      'Scheduled this session to auto-resume in 2 hours.',
      'I\'ll pause here and check back in 2 hours.'
    )],
    // Schedule task scenario
    ['schedule task', new ToolUseScenario(
      'mcp__user-input__schedule_task',
      {
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * 1-5',
        prompt: 'Check for new issues and summarize them',
        name: 'Daily Issue Summary',
        timezone: 'America/New_York',
      },
      'Task scheduled successfully. ID: task_123',
      'I\'ve scheduled the daily issue summary task.'
    )],
    // Wide, many-column markdown table to exercise table breakout (SUP-319).
    ['wide table', new SimpleTextResponseScenario(
      'Here is the quarterly breakdown:\n\n' +
      '| Region | Q1 Revenue | Q2 Revenue | Q3 Revenue | Q4 Revenue | Headcount | Churn % | NPS | CAC | LTV |\n' +
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
      '| North America | $1,240,000 | $1,380,000 | $1,510,000 | $1,720,000 | 142 | 3.2% | 48 | $310 | $4,200 |\n' +
      '| Europe | $980,000 | $1,050,000 | $1,190,000 | $1,330,000 | 118 | 4.1% | 41 | $290 | $3,800 |\n' +
      '| Asia Pacific | $720,000 | $860,000 | $1,020,000 | $1,240,000 | 96 | 5.0% | 39 | $265 | $3,500 |\n' +
      '| Latin America | $410,000 | $470,000 | $540,000 | $620,000 | 54 | 6.3% | 35 | $240 | $3,100 |\n'
    )],
  ])
  static defaultScenario: MockScenario = new SimpleTextResponseScenario(
    'This is a mock response from the E2E test container.'
  )

  // Test recorders — capture composer options sent with each call so E2E specs
  // can assert on them. Cleared via resetCallRecords().
  static lastSendMessageCall: {
    sessionId: string
    content: string
    effort?: string
    speed?: string
    model?: string
  } | null = null
  static sendMessageCalls: Array<{
    sessionId: string
    content: string
    effort?: string
    speed?: string
    model?: string
  }> = []
  static lastCreateSessionCall: {
    effort?: string
    speed?: string
    model?: string
    initialMessage?: string
  } | null = null
  static createSessionCalls: Array<{
    effort?: string
    speed?: string
    model?: string
    initialMessage?: string
  }> = []

  static resetCallRecords(): void {
    MockContainerClient.lastSendMessageCall = null
    MockContainerClient.sendMessageCalls = []
    MockContainerClient.lastCreateSessionCall = null
    MockContainerClient.createSessionCalls = []
  }

  /**
   * Append a record to a per-data-dir JSONL file for E2E test inspection.
   * Tests read this file with `fs` to assert the runtime options the renderer
   * sent through the full API path. No-op outside E2E mode.
   */
  private writeMockRecord(record: Record<string, unknown>): void {
    if (process.env.E2E_MOCK !== 'true') return
    try {
      const dir = process.env.SUPERAGENT_DATA_DIR
      if (!dir) return
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, '.e2e-mock-recorder.jsonl')
      fs.appendFileSync(file, JSON.stringify(record) + '\n')
    } catch {
      // Recording is best-effort — don't break the mock if the FS write fails.
    }
  }

  private config: ContainerConfig
  private running: boolean = false
  private activeBrowserSessionId: string | null = null
  private sessions: Map<string, ContainerSession> = new Map()
  private streamCallbacks: Map<string, Set<(message: StreamMessage) => void>> = new Map()
  // Map from containerSessionId to our internal sessionId (which is the same as the API sessionId)
  private sessionToApiSession: Map<string, string> = new Map()
  // Track pending user input requests per session for auto-completion
  private pendingInputCounts: Map<string, number> = new Map()

  constructor(config: ContainerConfig) {
    super()
    this.config = config
  }

  // Uuids supplied with sendMessage/createSession, consumed by writeJsonlEntry
  // when the scenario echoes the user message into the JSONL.
  private pendingUserMessageUuids = new Map<string, Array<{ uuid: string; content: string }>>()

  // Sessions with a scenario currently running (between scenario start and its
  // 'result' event). Messages sent while busy take the queued/steering path,
  // mirroring the real CLI.
  private busySessions = new Set<string>()
  // Background tasks the mock runtime considers still running, per session.
  // Mirrors the real CLI: 'idle' is withheld while any of these exist.
  private runningBackgroundTaskIds = new Map<string, Set<string>>()

  // Pending steering injections by message uuid, so queued messages can be
  // cancelled before pickup (mirrors the CLI's cancel_async_message).
  private queuedSteeringTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

  // Interrupt epoch per session — bumped by interruptSession() to supersede
  // the in-flight scenario (see scenarioView).
  private interruptEpochs = new Map<string, number>()

  getAgentId(): string {
    return this.config.agentId
  }

  setActiveBrowserSession(sessionId: string | null): void {
    this.activeBrowserSessionId = sessionId
  }

  /**
   * Write a JSONL entry for a session
   */
  writeJsonlEntry(containerSessionId: string, entry: Record<string, unknown>): void {
    // Get the API session ID (same as container session ID in our mock)
    const apiSessionId = containerSessionId
    const agentSlug = this.config.agentId

    try {
      const jsonlPath = getSessionJsonlPath(agentSlug, apiSessionId)

      // Ensure the directory exists
      const dir = path.dirname(jsonlPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // User-message echoes adopt the uuid supplied with the send (mirrors the
      // real CLI persisting the SDKUserMessage uuid), so optimistic-UI ghost
      // matching by id works in E2E mock mode. Matched by content so tool
      // results / task notifications (also type 'user') don't consume uuids.
      if (!entry.uuid && entry.type === 'user') {
        const queue = this.pendingUserMessageUuids.get(containerSessionId)
        const content = (entry.message as { content?: unknown } | undefined)?.content
        const idx = queue?.findIndex((q) => q.content === content) ?? -1
        if (queue && idx >= 0) {
          entry.uuid = queue[idx].uuid
          queue.splice(idx, 1)
        }
      }

      // Ensure uuid/parentUuid/sessionId so entries conform to JsonlMessageEntry
      if (!entry.uuid) entry.uuid = randomUUID()
      if (!('parentUuid' in entry)) entry.parentUuid = null
      if (!entry.sessionId) entry.sessionId = apiSessionId

      // Append the entry as a JSON line
      fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n')
      console.log(`[MockContainerClient] Wrote JSONL entry to ${jsonlPath}`)
    } catch (error) {
      console.error(`[MockContainerClient] Failed to write JSONL entry:`, error)
    }
  }

  /**
   * Register a scenario for a specific message pattern
   */
  static registerScenario(pattern: string, scenario: MockScenario): void {
    MockContainerClient.scenarios.set(pattern, scenario)
  }

  /**
   * Clear all registered scenarios
   */
  static clearScenarios(): void {
    MockContainerClient.scenarios.clear()
  }

  /**
   * Register pending input count for a session. When all inputs are resolved/rejected
   * via fetch(), the session emits a result event to complete.
   */
  registerPendingInputs(sessionId: string, count: number): void {
    this.pendingInputCounts.set(sessionId, count)
    console.log(`[MockContainerClient] Registered ${count} pending inputs for session ${sessionId}`)
  }

  /**
   * Emit a stream message to all subscribers of a session
   */
  emitStreamMessage(sessionId: string, content: { type: string; content: unknown }): void {
    // A scenario's result ends the turn — messages sent after this take the
    // normal (turn-starting) path again
    if (content.type === 'result') {
      this.busySessions.delete(sessionId)
    }
    const callbacks = this.streamCallbacks.get(sessionId)
    if (callbacks) {
      const message: StreamMessage = {
        type: content.type,
        content: content.content,
        timestamp: new Date(),
        sessionId,
      }
      callbacks.forEach((cb) => cb(message))
      this.emit('message', sessionId, content)
    }
    // Mirror the real CLI's session_state_changed lifecycle: 'idle' is the
    // authoritative settled signal and is withheld while queued (steering)
    // messages are still awaiting pickup or background tasks are still
    // running — their completion emits it instead.
    if (content.type === 'result') {
      const timers = this.queuedSteeringTimers.get(sessionId)
      const bgTasks = this.runningBackgroundTaskIds.get(sessionId)
      if ((!timers || timers.size === 0) && (!bgTasks || bgTasks.size === 0)) {
        this.emitSessionState(sessionId, 'idle')
      }
    }
  }

  /**
   * Track a running background task — the real runtime stays non-idle while
   * background work runs, so the result hook withholds 'idle' until the
   * scenario marks the task complete.
   */
  registerBackgroundTask(sessionId: string, taskId: string): void {
    const tasks = this.runningBackgroundTaskIds.get(sessionId) ?? new Set()
    tasks.add(taskId)
    this.runningBackgroundTaskIds.set(sessionId, tasks)
  }

  completeBackgroundTask(sessionId: string, taskId: string): void {
    this.runningBackgroundTaskIds.get(sessionId)?.delete(taskId)
  }

  /** Emit a session_state_changed system event (mirrors CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS). */
  emitSessionState(sessionId: string, stateValue: 'idle' | 'running'): void {
    this.emitStreamMessage(sessionId, {
      type: 'system',
      content: { type: 'system', subtype: 'session_state_changed', state: stateValue },
    })
  }

  // Volume flag builder (no-op in mock — mounts are not simulated)
  buildVolumeFlag(hostPath: string, containerPath: string): string {
    return `"${hostPath}:${containerPath}"`
  }

  // No real host networking in mock mode — report loopback-direct (no proxy).
  getHostBridgeIp(): string | null {
    return null
  }

  // No runner network to probe from in mock mode.
  async probeHostPortFromRunner(_host: string, _port: number): Promise<'reachable' | 'unreachable' | 'unknown'> {
    return 'unknown'
  }

  // Lifecycle management

  async start(options?: StartOptions): Promise<void> {
    this.running = true
    // Surface the container env that carries the proxy credentials so E2E
    // specs can call the API/MCP proxies the way a real container would
    // (there is deliberately no HTTP endpoint that returns the proxy token).
    if (options?.envVars?.['PROXY_TOKEN']) {
      this.writeMockRecord({
        type: 'container_start',
        agentSlug: this.config.agentId,
        proxyToken: options.envVars['PROXY_TOKEN'],
        remoteMcps: options.envVars['REMOTE_MCPS'] ?? null,
        timestamp: new Date().toISOString(),
      })
    }
    console.log(`[MockContainerClient] Started mock container for agent ${this.config.agentId}`)
  }

  async stop(_options?: StopOptions): Promise<{ forceStopUsed: boolean; stopped: boolean }> {
    if (this.activeBrowserSessionId && cleanupBrowserSessionFn) {
      cleanupBrowserSessionFn(this.activeBrowserSessionId)
      this.activeBrowserSessionId = null
    }
    this.running = false
    this.sessions.clear()
    this.streamCallbacks.clear()
    console.log(`[MockContainerClient] Stopped mock container for agent ${this.config.agentId}`)
    return { forceStopUsed: false, stopped: true }
  }

  stopSync(): void {
    if (this.activeBrowserSessionId && cleanupBrowserSessionFn) {
      cleanupBrowserSessionFn(this.activeBrowserSessionId)
      this.activeBrowserSessionId = null
    }
    this.running = false
    this.sessions.clear()
    this.streamCallbacks.clear()
    console.log(`[MockContainerClient] Stopped mock container (sync) for agent ${this.config.agentId}`)
  }

  // Query methods

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return {
      status: this.running ? 'running' : 'stopped',
      port: this.running ? 3000 : null,
    }
  }

  async getInfo(): Promise<ContainerInfo> {
    return this.getInfoFromRuntime()
  }

  getHostAuthHeaders(): Record<string, string> {
    return {}
  }

  async fetch(fetchPath: string, _init?: RequestInit): Promise<Response> {
    // Mock fetch - return appropriate empty responses based on path

    // Browser status — used by frontend when WebSocket closes to check if browser is still active
    if (fetchPath === '/browser/status') {
      return new Response(JSON.stringify({
        active: this.activeBrowserSessionId !== null,
        sessionId: this.activeBrowserSessionId,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Endpoints that return arrays need to return [] not {}
    if (fetchPath === '/artifacts') {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Dashboard artifact HTML — serves a minimal page for E2E testing of polyfill injection
    if (fetchPath.match(/^\/artifacts\/[^/]+\/?$/) || fetchPath.match(/^\/artifacts\/[^/]+\/index\.html$/)) {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mock Dashboard</title></head><body><h1>Mock Dashboard</h1><script>window.__DASHBOARD_LOADED__ = true;</script></body></html>`
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // Handle input resolve/reject — decrement pending count and complete session when all done
    const resolveMatch = fetchPath.match(/^\/inputs\/([^/]+)\/(resolve|reject)$/)
    if (resolveMatch) {
      let toolUseId = resolveMatch[1]
      try {
        toolUseId = decodeURIComponent(toolUseId)
      } catch {
        // Malformed escape — keep the raw path segment (mock tool ids are alphanumeric anyway)
      }
      console.log(`[MockContainerClient] Input ${resolveMatch[2]}: ${fetchPath}`)
      // Find the session with pending inputs (we only have one active at a time in tests)
      for (const [sessionId, count] of this.pendingInputCounts) {
        if (count > 0) {
          const remaining = count - 1
          this.pendingInputCounts.set(sessionId, remaining)
          console.log(`[MockContainerClient] Session ${sessionId}: ${remaining} pending inputs remaining`)
          // The real SDK surfaces each resolved/rejected input as a 'user' message
          // carrying the tool_result block — persisted to the transcript and
          // streamed so MessagePersister broadcasts `tool_result` to every SSE
          // client (this is what lets other tabs drop the resolved card).
          const toolResultBlocks = [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: resolveMatch[2] === 'resolve' ? 'User provided input' : 'User declined the request',
          }]
          this.writeJsonlEntry(sessionId, {
            type: 'user',
            message: { content: toolResultBlocks },
            timestamp: new Date().toISOString(),
          })
          this.emitStreamMessage(sessionId, {
            type: 'user',
            content: { type: 'user', message: { content: toolResultBlocks } },
          })
          if (remaining === 0) {
            this.pendingInputCounts.delete(sessionId)
            // Complete the session after a short delay
            setTimeout(() => {
              this.writeJsonlEntry(sessionId, {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'Thank you for providing the information.' }],
                },
                timestamp: new Date().toISOString(),
              })
              this.emitStreamMessage(sessionId, {
                type: 'result',
                content: { type: 'result', subtype: 'success' },
              })
            }, 50)
          }
          break
        }
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Resource stats

  async getStats(): Promise<ContainerStats | null> {
    if (!this.running) return null
    return {
      memoryUsageBytes: 256 * 1024 * 1024, // 256 MiB
      memoryLimitBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
      memoryPercent: 12.5,
      cpuPercent: 5.0,
    }
  }

  getWebSocketBaseUrl(port: number): string {
    return `ws://127.0.0.1:${port}`
  }

  getHostApiBaseUrl(): string {
    return 'http://127.0.0.1:3000'
  }

  // Health checks

  async waitForHealthy(_timeoutMs?: number, _knownPort?: number): Promise<boolean> {
    return this.running
  }

  async isHealthy(_knownPort?: number): Promise<boolean> {
    return this.running
  }

  // Session management

  async createSession(options: CreateSessionOptions): Promise<ContainerSession> {
    // Resolve the selection exactly as the real container client does, so E2E
    // assertions see the concrete wire id the SDK would receive.
    const model = resolveContainerModel(options.model, 'agent')
    // Record for E2E test assertions
    MockContainerClient.lastCreateSessionCall = {
      effort: options.effort,
      speed: options.speed,
      model,
      initialMessage: options.initialMessage,
    }
    MockContainerClient.createSessionCalls.push({
      effort: options.effort,
      speed: options.speed,
      model,
      initialMessage: options.initialMessage,
    })
    this.writeMockRecord({
      type: 'createSession',
      agentSlug: this.config.agentId,
      effort: options.effort,
      speed: options.speed,
      model,
      initialMessage: options.initialMessage,
      // Secret env var NAMES the host resolved from the agent .env and passed to
      // the container — lets E2E assert a UI-added secret reaches the container
      // through the full setSecret → .env → listSecrets path.
      availableEnvVars: options.availableEnvVars,
      timestamp: new Date().toISOString(),
    })

    // Simulate container startup latency for onboarding sessions so the
    // "Setting up your agent…" modal is visible long enough for E2E assertions.
    if (options.initialMessage?.includes('agent-onboarding')) {
      await new Promise((r) => setTimeout(r, 2000))
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    const now = new Date().toISOString()

    const session: ContainerSession = {
      id: sessionId,
      createdAt: now,
      lastActivity: now,
      workingDirectory: '/workspace',
      slashCommands: [],
    }

    this.sessions.set(sessionId, session)
    this.streamCallbacks.set(sessionId, new Set())

    console.log(`[MockContainerClient] Created session ${sessionId}`)

    // If there's an initial message, process it after a longer delay
    // to ensure the caller has time to subscribe to the stream
    if (options.initialMessage) {
      if (options.initialMessageUuid) {
        this.pendingUserMessageUuids.set(sessionId, [
          { uuid: options.initialMessageUuid, content: options.initialMessage },
        ])
      }
      // Delay message emission to give time for subscription
      // The API subscribes after createSession returns, so we need to wait
      setTimeout(() => {
        this.emitStreamMessage(sessionId, {
          type: 'user_message',
          content: { content: options.initialMessage },
        })

        // Find matching scenario or use default
        let scenario = MockContainerClient.defaultScenario
        for (const [pattern, s] of MockContainerClient.scenarios) {
          if (options.initialMessage!.toLowerCase().includes(pattern.toLowerCase())) {
            scenario = s
            break
          }
        }

        // Execute the scenario (session is busy until the scenario's 'result').
        // Deliberately do NOT emit a 'running' state event here: a CLI run starts
        // already in 'running' and only PUBLISHES transitions, so the session's
        // very first turn emits nothing until its final idle. Emitting 'running'
        // here would let the host discover state-event support by observation —
        // masking a regression of the capabilities handshake that the host
        // actually relies on (the exact failure that already shipped once).
        this.busySessions.add(sessionId)
        scenario.execute(sessionId, this.scenarioView(sessionId), options.initialMessage!)
      }, 100)  // Brief delay to ensure subscription is set up
    }

    return session
  }

  async getSession(sessionId: string): Promise<ContainerSession | null> {
    return this.sessions.get(sessionId) || null
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.sessions.has(sessionId)
    this.sessions.delete(sessionId)
    this.streamCallbacks.delete(sessionId)
    this.pendingUserMessageUuids.delete(sessionId)
    this.busySessions.delete(sessionId)
    const timers = this.queuedSteeringTimers.get(sessionId)
    if (timers) {
      for (const timer of timers.values()) clearTimeout(timer)
      this.queuedSteeringTimers.delete(sessionId)
    }
    this.interruptEpochs.delete(sessionId)
    console.log(`[MockContainerClient] Deleted session ${sessionId}`)
    return existed
  }

  // Message operations

  async sendMessage(sessionId: string, content: string, uuid?: string, options?: RuntimeOptions): Promise<void> {
    // Resolve like the real container client so E2E sees the concrete wire id.
    const model = resolveContainerModel(options?.model, 'agent')
    // Record for E2E test assertions
    MockContainerClient.lastSendMessageCall = {
      sessionId,
      content,
      effort: options?.effort,
      speed: options?.speed,
      model,
    }
    MockContainerClient.sendMessageCalls.push({
      sessionId,
      content,
      effort: options?.effort,
      speed: options?.speed,
      model,
    })
    this.writeMockRecord({
      type: 'sendMessage',
      agentSlug: this.config.agentId,
      sessionId,
      content,
      effort: options?.effort,
      speed: options?.speed,
      model,
      timestamp: new Date().toISOString(),
    })
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Update last activity
    session.lastActivity = new Date().toISOString()

    // shouldQuery: false — append to transcript without triggering a response
    if (options?.shouldQuery === false) {
      return
    }

    // Mid-turn send — mirror the real CLI's steering behavior: no user entry
    // is written; after a pickup delay the message lands in the JSONL as a
    // queued_command attachment with a CLI-generated source_uuid (the sender
    // uuid is NOT preserved there), followed by assistant output whose stream
    // message triggers the refetch that materializes the ghost. Until pickup
    // the injection is cancellable by uuid (cancel_async_message semantics).
    if (this.busySessions.has(sessionId)) {
      // Content keyword lets tests pick the long pickup window: with the slow
      // scenario's 5s turn, an 8000ms delay deterministically lands pickup
      // AFTER the turn's result and leaves an observable pending window for the
      // late-window settle path no matter when the message was queued.
      const steeringDelayMs = content.includes('pickup after turn') ? 8000 : 1200
      const steeringUuid = uuid ?? randomUUID()
      const timer = setTimeout(() => {
        this.queuedSteeringTimers.get(sessionId)?.delete(steeringUuid)
        // The drain signal: the real CLI emits status 'requesting' when it
        // picks queued messages up — the persister clears its pending-queued
        // set and broadcasts a refetch on it.
        this.emitStreamMessage(sessionId, {
          type: 'system',
          content: { type: 'system', subtype: 'status', status: 'requesting' },
        })
        this.writeJsonlEntry(sessionId, {
          type: 'attachment',
          timestamp: new Date().toISOString(),
          attachment: {
            type: 'queued_command',
            prompt: [{ type: 'text', text: content }],
            source_uuid: randomUUID(),
            commandMode: 'prompt',
          },
        })
        const ackContent = [{ type: 'text', text: `Adjusting based on: ${content}` }]
        this.writeJsonlEntry(sessionId, {
          type: 'assistant',
          message: { content: ackContent },
          timestamp: new Date().toISOString(),
        })
        this.emitStreamMessage(sessionId, {
          type: 'assistant',
          content: { type: 'assistant', message: { content: ackContent } },
        })
        // If the turn's result already fired (queued late in the window), this
        // pickup is the real end of the session's work — settle it now.
        const remaining = this.queuedSteeringTimers.get(sessionId)
        if (!this.busySessions.has(sessionId) && (!remaining || remaining.size === 0)) {
          this.emitSessionState(sessionId, 'idle')
        }
      }, steeringDelayMs)
      const timers = this.queuedSteeringTimers.get(sessionId) ?? new Map()
      timers.set(steeringUuid, timer)
      this.queuedSteeringTimers.set(sessionId, timers)
      return
    }

    // Remember the uuid so the scenario's JSONL echo of this message gets it
    if (uuid) {
      const queue = this.pendingUserMessageUuids.get(sessionId) ?? []
      queue.push({ uuid, content })
      this.pendingUserMessageUuids.set(sessionId, queue)
    }

    // Emit user message to stream
    this.emitStreamMessage(sessionId, {
      type: 'user_message',
      content: { content },
    })

    // Find matching scenario or use default
    let scenario = MockContainerClient.defaultScenario
    for (const [pattern, s] of MockContainerClient.scenarios) {
      if (content.toLowerCase().includes(pattern.toLowerCase())) {
        scenario = s
        break
      }
    }

    // Execute the scenario (session is busy until the scenario's 'result').
    // Unlike the first turn (createSession), this is a real idle -> running
    // transition (a message waking a settled session), which the CLI does
    // publish — so emitting 'running' here mirrors the runtime.
    this.busySessions.add(sessionId)
    this.emitSessionState(sessionId, 'running')
    scenario.execute(sessionId, this.scenarioView(sessionId), content)
  }

  async cancelQueuedMessage(sessionId: string, uuid: string): Promise<boolean> {
    const timers = this.queuedSteeringTimers.get(sessionId)
    const timer = timers?.get(uuid)
    if (!timer) return false
    clearTimeout(timer)
    timers!.delete(uuid)
    console.log(`[MockContainerClient] Cancelled queued message ${uuid} in session ${sessionId}`)
    return true
  }

  /**
   * A view of this client handed to a scenario execution, pinned to the
   * session's interrupt epoch at turn start. interruptSession() bumps the
   * epoch, which turns the superseded scenario's remaining scheduled
   * emissions (stream events and JSONL writes from its pending setTimeouts)
   * into no-ops — observationally the same as cancelling the timers, without
   * threading a cancellation handle through every scenario. Mirrors the real
   * CLI: an aborted turn produces no further output.
   */
  private scenarioView(sessionId: string): MockContainerClient {
    const epoch = this.interruptEpochs.get(sessionId) ?? 0
    const live = () => (this.interruptEpochs.get(sessionId) ?? 0) === epoch
    const view = Object.create(this) as MockContainerClient
    view.emitStreamMessage = (sid: string, content: { type: string; content: unknown }): void => {
      if (live()) this.emitStreamMessage(sid, content)
    }
    view.writeJsonlEntry = (sid: string, entry: Record<string, unknown>): void => {
      if (live()) this.writeJsonlEntry(sid, entry)
    }
    return view
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    // Supersede the in-flight scenario so its pending timers can't finish the
    // turn after the abort (see scenarioView), and let the next send start a
    // fresh turn instead of taking the mid-turn steering path.
    this.interruptEpochs.set(sessionId, (this.interruptEpochs.get(sessionId) ?? 0) + 1)
    this.busySessions.delete(sessionId)

    // Queued steering messages die with the turn — the real CLI never picks
    // them up after an abort. Mirror the real container: it names each dead
    // uuid with a synthetic command_lifecycle 'discarded' frame (the SDK's own
    // frames die with the aborted query), which the renderer uses to rescue
    // the ghost's text into the composer deterministically.
    const timers = this.queuedSteeringTimers.get(sessionId)
    if (timers) {
      const deadUuids = [...timers.keys()]
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const uuid of deadUuids) {
        this.emitStreamMessage(sessionId, {
          type: 'command_lifecycle',
          content: { type: 'command_lifecycle', command_uuid: uuid, state: 'discarded' },
        })
      }
    }

    this.emitStreamMessage(sessionId, {
      type: 'session_idle',
      content: { interrupted: true },
    })
    return true
  }

  // Streaming

  subscribeToStream(
    sessionId: string,
    callback: (message: StreamMessage) => void
  ): { unsubscribe: () => void; ready: Promise<void> } {
    let callbacks = this.streamCallbacks.get(sessionId)
    if (!callbacks) {
      callbacks = new Set()
      this.streamCallbacks.set(sessionId, callbacks)
    }
    callbacks.add(callback)

    console.log(`[MockContainerClient] Subscribed to stream for session ${sessionId}`)

    // Mirror the real container's WS hello: announce the stream contract
    // before any relayed message so the persister treats state events as the
    // idle authority from the first turn (the mock emits them — see
    // emitSessionState).
    callback({
      type: 'system',
      content: { type: 'system', subtype: 'capabilities', session_state_events: true },
      timestamp: new Date(),
      sessionId,
    })

    const unsubscribe = () => {
      callbacks?.delete(callback)
      console.log(`[MockContainerClient] Unsubscribed from stream for session ${sessionId}`)
    }

    return { unsubscribe, ready: Promise.resolve() }
  }

  // Events (inherited from EventEmitter)
  // on, off are already available from EventEmitter
}
