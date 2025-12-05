import { query, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';

/**
 * Async message queue that bridges imperative sendMessage() calls
 * to an async iterable for the SDK's streaming input mode.
 */
class MessageQueue {
  private queue: SDKUserMessage[] = [];
  private resolveNext: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error('MessageQueue is closed');
    }

    if (this.resolveNext) {
      // Someone is waiting for a message
      this.resolveNext({ value: message, done: false });
      this.resolveNext = null;
    } else {
      // Queue it for later
      this.queue.push(message);
    }
  }

  close(): void {
    this.closed = true;
    if (this.resolveNext) {
      this.resolveNext({ value: undefined as any, done: true });
      this.resolveNext = null;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        return new Promise((resolve) => {
          if (this.queue.length > 0) {
            // Return queued message immediately
            resolve({ value: this.queue.shift()!, done: false });
          } else if (this.closed) {
            resolve({ value: undefined as any, done: true });
          } else {
            // Wait for next message
            this.resolveNext = resolve;
          }
        });
      },
    };
  }
}

export class ClaudeCodeProcess extends EventEmitter {
  private queryInstance: Query | null = null;
  private messageQueue: MessageQueue | null = null;
  private abortController: AbortController | null = null;
  private sessionId: string;
  private workingDirectory: string;
  private claudeSessionId: string | null;
  private isReady: boolean = false;
  private isProcessing: boolean = false;

  constructor(
    sessionId: string,
    workingDirectory: string,
    claudeSessionId?: string
  ) {
    super();
    this.sessionId = sessionId;
    this.workingDirectory = workingDirectory;
    this.claudeSessionId = claudeSessionId || null;
  }

  async start(): Promise<void> {
    const isResuming = !!this.claudeSessionId;
    console.log(`[Session ${this.sessionId}] Starting SDK-based session`);
    console.log(`[Session ${this.sessionId}] ANTHROPIC_API_KEY set:`, !!process.env.ANTHROPIC_API_KEY);
    console.log(`[Session ${this.sessionId}] Working directory:`, this.workingDirectory);
    console.log(`[Session ${this.sessionId}] Resuming:`, isResuming, this.claudeSessionId);

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    // Create message queue for streaming input
    this.messageQueue = new MessageQueue();

    // Start the query with streaming input mode
    this.queryInstance = query({
      prompt: this.messageQueue,
      options: {
        cwd: this.workingDirectory,
        abortController: this.abortController,
        resume: this.claudeSessionId || undefined,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
      },
    });

    this.isReady = true;
    this.emit('ready');

    // Start processing messages in the background
    this.processMessages();
  }

  private async processMessages(): Promise<void> {
    if (!this.queryInstance) return;

    this.isProcessing = true;

    try {
      for await (const message of this.queryInstance) {
        // Capture Claude session ID from init message
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.claudeSessionId = message.session_id;
          console.log(`[Session ${this.sessionId}] Captured Claude session ID:`, this.claudeSessionId);
          this.emit('claude-session-id', this.claudeSessionId);
        }

        // Emit the SDK message
        console.log(`[Session ${this.sessionId}] SDK message:`, message.type,
          'subtype' in message ? (message as any).subtype : '');
        this.emit('message', message);

        // Check for result message to know when processing is complete
        if (message.type === 'result') {
          console.log(`[Session ${this.sessionId}] Query completed`);
        }
      }
    } catch (error: any) {
      // Check for abort error in multiple ways (SDK may use different error types)
      const isAbortError =
        error.name === 'AbortError' ||
        error.constructor?.name === 'AbortError' ||
        error.message?.includes('aborted') ||
        error.message?.includes('abort');

      if (isAbortError) {
        console.log(`[Session ${this.sessionId}] Query aborted`);
      } else {
        console.error(`[Session ${this.sessionId}] Query error:`, error);
        // Only emit if there are listeners to prevent crash
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
      }
    } finally {
      this.isProcessing = false;
      this.isReady = false;
      this.emit('exit', 0);
    }
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.messageQueue || !this.isReady) {
      throw new Error('Claude Code session is not running');
    }

    // Create SDK user message format
    const message: SDKUserMessage = {
      type: 'user',
      session_id: this.claudeSessionId || this.sessionId,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: content,
          },
        ],
      },
      parent_tool_use_id: null,
    };

    console.log(`[Session ${this.sessionId}] Sending message:`, content.substring(0, 100));
    this.messageQueue.push(message);
  }

  async stop(): Promise<void> {
    console.log(`[Session ${this.sessionId}] Stopping session`);

    // Close the message queue to signal end of input
    if (this.messageQueue) {
      this.messageQueue.close();
    }

    // Abort the query if still running
    if (this.abortController) {
      this.abortController.abort();
    }

    // Wait a moment for cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.isReady = false;
    this.queryInstance = null;
    this.messageQueue = null;
    this.abortController = null;
  }

  isRunning(): boolean {
    return this.isReady && this.isProcessing;
  }

  async interrupt(): Promise<void> {
    console.log(`[Session ${this.sessionId}] Interrupting current query`);

    if (!this.abortController || !this.isProcessing) {
      console.log(`[Session ${this.sessionId}] Nothing to interrupt`);
      return;
    }

    // Abort the current query
    this.abortController.abort();

    // Wait for the current processing to stop
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isProcessing) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });

    // Restart the query with resume to continue the session
    console.log(`[Session ${this.sessionId}] Restarting query after interrupt`);

    // Create new abort controller and message queue
    this.abortController = new AbortController();
    this.messageQueue = new MessageQueue();

    // Start a new query with resume
    this.queryInstance = query({
      prompt: this.messageQueue,
      options: {
        cwd: this.workingDirectory,
        abortController: this.abortController,
        resume: this.claudeSessionId || undefined,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
      },
    });

    this.isReady = true;

    // Start processing messages again
    this.processMessages();
  }
}
