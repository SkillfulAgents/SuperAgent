import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  ContainerSession,
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
 * Mock implementation of ContainerClient for E2E testing.
 * Simulates container behavior without requiring Docker/Podman.
 */
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
  ])
  static defaultScenario: MockScenario = new SimpleTextResponseScenario(
    'This is a mock response from the E2E test container.'
  )

  private config: ContainerConfig
  private running: boolean = false
  private sessions: Map<string, ContainerSession> = new Map()
  private sessionMessages: Map<string, unknown[]> = new Map()
  private streamCallbacks: Map<string, Set<(message: StreamMessage) => void>> = new Map()
  // Map from containerSessionId to our internal sessionId (which is the same as the API sessionId)
  private sessionToApiSession: Map<string, string> = new Map()

  constructor(config: ContainerConfig) {
    super()
    this.config = config
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

  // Lifecycle management

  async start(_options?: StartOptions): Promise<void> {
    this.running = true
    console.log(`[MockContainerClient] Started mock container for agent ${this.config.agentId}`)
  }

  async stop(): Promise<void> {
    this.running = false
    this.sessions.clear()
    this.sessionMessages.clear()
    this.streamCallbacks.clear()
    console.log(`[MockContainerClient] Stopped mock container for agent ${this.config.agentId}`)
  }

  stopSync(): void {
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

  async fetch(_path: string, _init?: RequestInit): Promise<Response> {
    // Mock fetch - return empty JSON response
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
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

  async sendMessage(sessionId: string, content: string): Promise<void> {
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
