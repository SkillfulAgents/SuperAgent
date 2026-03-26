import { EventEmitter } from 'events'
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
  StreamMessage,
} from './types'
import { getSessionJsonlPath } from '../utils/file-storage'

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
    const finalDelay = 300 + words.length * 30

    // Start assistant message - wrapped in stream_event
    // The content needs a 'type' field that MessagePersister.handleMessage switches on
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, 50)

    // Stream content block start - text block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, 100)

    // Stream text in chunks
    words.forEach((word, i) => {
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (i > 0 ? ' ' : '') + word } } },
        })
      }, 150 + i * 30)
    })

    // End content block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, 200 + words.length * 30)

    // End message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, 250 + words.length * 30)

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
    let delay = 50
    const toolId = `tool_${Date.now()}`

    // Start assistant message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 50

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
    delay += 50

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
    delay += 100

    // Tool use stop
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 50

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
    delay += 100

    // Final text response - new text block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, delay)
    delay += 50

    const words = this.finalText.split(' ')
    words.forEach((word, i) => {
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (i > 0 ? ' ' : '') + word } } },
        })
      }, delay + i * 30)
    })
    delay += words.length * 30 + 50

    // End content block
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 50

    // End message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 50

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
export interface UserInputTool {
  name: string
  input: Record<string, unknown>
}

export class UserInputRequestScenario implements MockScenario {
  constructor(private tools: UserInputTool[]) {}

  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    let delay = 50
    const toolIds: string[] = []

    // Pre-generate tool IDs so we can register pending inputs immediately
    for (let i = 0; i < this.tools.length; i++) {
      toolIds.push(`tool_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`)
    }

    // Register pending inputs BEFORE emitting any events, so that
    // resolve/reject calls from the API can find and decrement the count.
    client.registerPendingInputs(sessionId, this.tools.length)

    // Start assistant message
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 50

    // Emit each tool use block
    for (let toolIndex = 0; toolIndex < this.tools.length; toolIndex++) {
      const tool = this.tools[toolIndex]
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
      delay += 50

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
      delay += 50

      // content_block_stop — triggers MessagePersister to detect user input tools
      setTimeout(() => {
        client.emitStreamMessage(sessionId, {
          type: 'stream_event',
          content: { type: 'stream_event', event: { type: 'content_block_stop' } },
        })
      }, delay)
      delay += 100
    }

    // message_stop
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 50

    // Write JSONL entries (for message-based recovery on page refresh)
    const capturedToolIds = [...toolIds]
    const capturedTools = [...this.tools]
    const finalDelay = delay
    setTimeout(() => {
      // Write user message
      client.writeJsonlEntry(sessionId, {
        type: 'user',
        message: { content: userMessage },
        timestamp: new Date().toISOString(),
      })

      // Write assistant message with all tool use blocks
      client.writeJsonlEntry(sessionId, {
        type: 'assistant',
        message: {
          content: capturedTools.map((tool, i) => ({
            type: 'tool_use',
            id: capturedToolIds[i],
            name: tool.name,
            input: tool.input,
          })),
        },
        timestamp: new Date().toISOString(),
      })
    }, finalDelay)
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
    let delay = 50

    // Start streaming an assistant message first
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_start' } },
      })
    }, delay)
    delay += 50

    // Stream some text
    const text = `Making API call: ${this.method} ${this.targetPath}`
    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
    }, delay)
    delay += 50

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
      })
    }, delay)
    delay += 50

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'content_block_stop' } },
      })
    }, delay)
    delay += 50

    setTimeout(() => {
      client.emitStreamMessage(sessionId, {
        type: 'stream_event',
        content: { type: 'stream_event', event: { type: 'message_stop' } },
      })
    }, delay)
    delay += 100

    // Now trigger the proxy review via ReviewManager
    const capturedDelay = delay
    setTimeout(async () => {
      const { reviewManager } = await import('../proxy/review-manager')
      // Fire-and-forget — the promise resolves when the user decides
      reviewManager.requestReview({
        agentSlug,
        accountId: 'mock-account-id',
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
    // Register the "list files" scenario for tool use tests
    ['list files', new ToolUseScenario(
      'Bash',
      { command: 'ls -la' },
      'file1.txt\nfile2.txt\nfolder/',
      'I found the following files in the current directory.'
    )],
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
    ['ask script', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_script_run',
        input: { script: 'sw_vers', explanation: 'Check macOS version', scriptType: 'shell' },
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
    // Proxy review scenario for E2E tests
    ['proxy review', new ProxyReviewScenario(
      'slack',
      'POST',
      'api/chat.postMessage',
      ['chat:write'],
      { 'chat:write': 'Send a message to a channel' }
    )],
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
        input: { toolkit: 'github', reason: 'Need access to your GitHub repositories' },
      },
    ])],
    // Remote MCP request scenario - URL will be overridden by test via registerScenario
    ['request mcp', new UserInputRequestScenario([
      {
        name: 'mcp__user-input__request_remote_mcp',
        input: { url: 'http://localhost:9876/mcp', name: 'Test MCP', reason: 'Need access to test tools' },
      },
    ])],
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
  ])
  static defaultScenario: MockScenario = new SimpleTextResponseScenario(
    'This is a mock response from the E2E test container.'
  )

  private config: ContainerConfig
  private running: boolean = false
  private activeBrowserSessionId: string | null = null
  private sessions: Map<string, ContainerSession> = new Map()
  private sessionMessages: Map<string, unknown[]> = new Map()
  private streamCallbacks: Map<string, Set<(message: StreamMessage) => void>> = new Map()
  // Map from containerSessionId to our internal sessionId (which is the same as the API sessionId)
  private sessionToApiSession: Map<string, string> = new Map()
  // Track pending user input requests per session for auto-completion
  private pendingInputCounts: Map<string, number> = new Map()

  constructor(config: ContainerConfig) {
    super()
    this.config = config
  }

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
  }

  // Volume flag builder (no-op in mock — mounts are not simulated)
  buildVolumeFlag(hostPath: string, containerPath: string): string {
    return `"${hostPath}:${containerPath}"`
  }

  // Lifecycle management

  async start(_options?: StartOptions): Promise<void> {
    this.running = true
    console.log(`[MockContainerClient] Started mock container for agent ${this.config.agentId}`)
  }

  async stop(): Promise<{ forceStopUsed: boolean }> {
    if (this.activeBrowserSessionId && cleanupBrowserSessionFn) {
      cleanupBrowserSessionFn(this.activeBrowserSessionId)
      this.activeBrowserSessionId = null
    }
    this.running = false
    this.sessions.clear()
    this.sessionMessages.clear()
    this.streamCallbacks.clear()
    console.log(`[MockContainerClient] Stopped mock container for agent ${this.config.agentId}`)
    return { forceStopUsed: false }
  }

  stopSync(): void {
    if (this.activeBrowserSessionId && cleanupBrowserSessionFn) {
      cleanupBrowserSessionFn(this.activeBrowserSessionId)
      this.activeBrowserSessionId = null
    }
    this.running = false
    this.sessions.clear()
    this.sessionMessages.clear()
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

    // Handle input resolve/reject — decrement pending count and complete session when all done
    const resolveMatch = fetchPath.match(/^\/inputs\/[^/]+\/(resolve|reject)$/)
    if (resolveMatch) {
      console.log(`[MockContainerClient] Input ${resolveMatch[1]}: ${fetchPath}`)
      // Find the session with pending inputs (we only have one active at a time in tests)
      for (const [sessionId, count] of this.pendingInputCounts) {
        if (count > 0) {
          const remaining = count - 1
          this.pendingInputCounts.set(sessionId, remaining)
          console.log(`[MockContainerClient] Session ${sessionId}: ${remaining} pending inputs remaining`)
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
            }, 200)
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

  // Health checks

  async waitForHealthy(_timeoutMs?: number): Promise<boolean> {
    return this.running
  }

  async isHealthy(): Promise<boolean> {
    return this.running
  }

  // Session management

  async createSession(options: CreateSessionOptions): Promise<ContainerSession> {
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
    this.sessionMessages.set(sessionId, [])
    this.streamCallbacks.set(sessionId, new Set())

    console.log(`[MockContainerClient] Created session ${sessionId}`)

    // If there's an initial message, process it after a longer delay
    // to ensure the caller has time to subscribe to the stream
    if (options.initialMessage) {
      // Store user message
      const userMessage = {
        role: 'user',
        content: options.initialMessage,
        timestamp: new Date().toISOString(),
      }
      this.sessionMessages.get(sessionId)?.push(userMessage)

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

        // Execute the scenario
        scenario.execute(sessionId, this, options.initialMessage!)
      }, 500)  // Increased delay to ensure subscription is set up
    }

    return session
  }

  async getSession(sessionId: string): Promise<ContainerSession | null> {
    return this.sessions.get(sessionId) || null
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.sessions.has(sessionId)
    this.sessions.delete(sessionId)
    this.sessionMessages.delete(sessionId)
    this.streamCallbacks.delete(sessionId)
    console.log(`[MockContainerClient] Deleted session ${sessionId}`)
    return existed
  }

  // Message operations

  async sendMessage(sessionId: string, content: string, _uuid?: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Update last activity
    session.lastActivity = new Date().toISOString()

    // Store user message
    const userMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    this.sessionMessages.get(sessionId)?.push(userMessage)

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

    // Execute the scenario
    scenario.execute(sessionId, this, content)
  }

  async getMessages(sessionId: string): Promise<unknown[]> {
    return this.sessionMessages.get(sessionId) || []
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (session) {
      // Emit interrupt event
      this.emitStreamMessage(sessionId, {
        type: 'session_idle',
        content: { interrupted: true },
      })
      return true
    }
    return false
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

    const unsubscribe = () => {
      callbacks?.delete(callback)
      console.log(`[MockContainerClient] Unsubscribed from stream for session ${sessionId}`)
    }

    return { unsubscribe, ready: Promise.resolve() }
  }

  // Events (inherited from EventEmitter)
  // on, off are already available from EventEmitter
}
