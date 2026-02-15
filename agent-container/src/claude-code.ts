import { query, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { userInputMcpServer, browserMcpServer, dashboardsMcpServer } from './mcp-server';
import { inputManager } from './input-manager';
import { setCurrentBrowserSessionId } from './tools/browser';

// Load platform system prompt from file
const PLATFORM_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system-prompt.md'),
  'utf-8'
);

// Load web-browser subagent prompt from file
const WEB_BROWSER_AGENT_PROMPT = fs.readFileSync(
  path.join(__dirname, 'web-browser-agent-prompt.md'),
  'utf-8'
);

/**
 * Parses connected accounts metadata from the CONNECTED_ACCOUNTS env var.
 * Format: {"toolkit": [{"name": "Display Name", "id": "uuid"}, ...]}
 */
function parseConnectedAccounts(): Map<string, Array<{ name: string; id: string }>> {
  const accounts = new Map<string, Array<{ name: string; id: string }>>();
  const raw = process.env.CONNECTED_ACCOUNTS;
  if (!raw) return accounts;

  try {
    const parsed = JSON.parse(raw) as Record<string, Array<{ name: string; id: string }>>;
    for (const [toolkit, entries] of Object.entries(parsed)) {
      if (entries.length > 0) {
        accounts.set(toolkit, entries);
      }
    }
  } catch {
    // Skip malformed JSON
  }

  return accounts;
}

/**
 * Generates the system prompt to append to the Claude Code preset.
 * Includes platform-specific instructions and available environment variables.
 */
function generateSystemPromptAppend(
  availableEnvVars?: string[],
  userSystemPrompt?: string
): string | undefined {
  const sections: string[] = [];

  // Platform instructions
  sections.push(PLATFORM_SYSTEM_PROMPT);

  // Parse connected accounts metadata
  const connectedAccounts = parseConnectedAccounts();

  // Filter out proxy/connected-account env vars from regular secrets
  const proxyEnvVars = new Set(['PROXY_BASE_URL', 'PROXY_TOKEN', 'CONNECTED_ACCOUNTS']);
  const regularEnvVars = (availableEnvVars || []).filter(
    name => !name.startsWith('CONNECTED_ACCOUNT_') && !proxyEnvVars.has(name)
  );

  // Connected accounts section with proxy usage instructions
  if (connectedAccounts.size > 0) {
    const accountSections: string[] = [];

    for (const [toolkit, entries] of connectedAccounts) {
      const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
      accountSections.push(
        `### ${displayName}\n${entries.map(e => `- ${e.name} (ID: \`${e.id}\`)`).join('\n')}`
      );
    }

    sections.push(`## Connected Accounts (Already Available)

**IMPORTANT: You already have access to the following connected accounts via the proxy. Do NOT request access to these - you already have it!**

${accountSections.join('\n\n')}

### How to Make API Calls

All API calls to external services go through a proxy that handles authentication automatically. Use the proxy URL with the account ID and target API host:

\`\`\`
URL: $PROXY_BASE_URL/<account_id>/<target_host>/<api_path>
Header: Authorization: Bearer $PROXY_TOKEN
\`\`\`

**Example (curl):**
\`\`\`bash
curl "$PROXY_BASE_URL/<account_id>/api.gmail.com/gmail/v1/users/me/messages" \\
  -H "Authorization: Bearer $PROXY_TOKEN"
\`\`\`

**Example (Python):**
\`\`\`python
import os, requests
proxy_url = os.environ["PROXY_BASE_URL"]
proxy_token = os.environ["PROXY_TOKEN"]
resp = requests.get(
    f"{proxy_url}/<account_id>/api.gmail.com/gmail/v1/users/me/messages",
    headers={"Authorization": f"Bearer {proxy_token}"}
)
\`\`\`

**Important notes:**
- Replace \`<account_id>\` with the ID shown above for the account you want to use
- The proxy handles token refresh automatically
- The \`CONNECTED_ACCOUNTS\` env var contains the full account metadata as JSON`);
  }

  // Available environment variables (regular secrets)
  if (regularEnvVars.length > 0) {
    sections.push(`## Available Environment Variables

The following environment variables have been configured for this agent and are available in your environment:

${regularEnvVars.map(name => `- \`${name}\``).join('\n')}

You can access these using standard environment variable methods (e.g., \`process.env.VAR_NAME\` in Node.js, \`os.environ['VAR_NAME']\` in Python, \`$VAR_NAME\` in shell scripts).`);
  }

  // User's custom system prompt
  if (userSystemPrompt?.trim()) {
    sections.push(`## Agent-Specific Instructions

${userSystemPrompt.trim()}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join('\n\n');
}

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

export interface ClaudeCodeProcessOptions {
  sessionId: string;
  workingDirectory: string;
  claudeSessionId?: string;
  userSystemPrompt?: string;
  availableEnvVars?: string[];
  model?: string;
}

export class ClaudeCodeProcess extends EventEmitter {
  private queryInstance: Query | null = null;
  private messageQueue: MessageQueue | null = null;
  private abortController: AbortController | null = null;
  private sessionId: string;
  private workingDirectory: string;
  private claudeSessionId: string | null;
  private systemPromptAppend: string | undefined;
  private model: string | undefined;
  private isReady: boolean = false;
  private isProcessing: boolean = false;

  constructor(options: ClaudeCodeProcessOptions) {
    super();
    this.sessionId = options.sessionId;
    this.workingDirectory = options.workingDirectory;
    this.claudeSessionId = options.claudeSessionId || null;
    this.model = options.model;
    this.systemPromptAppend = generateSystemPromptAppend(
      options.availableEnvVars,
      options.userSystemPrompt
    );
    // Set the session ID for browser tools so they can identify the owning session
    setCurrentBrowserSessionId(this.sessionId);
  }

  /**
   * Creates a new query instance with the standard configuration.
   * Used by start(), restart(), and interrupt() to avoid duplication.
   */
  private createQuery(): Query {
    return query({
      prompt: this.messageQueue!,
      options: {
        model: this.model,
        cwd: this.workingDirectory,
        abortController: this.abortController!,
        resume: this.claudeSessionId || undefined,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        settingSources: ['user', 'project'],
        allowedTools: ['Skill', 'Task'],
        mcpServers: {
          'user-input': userInputMcpServer,
          'browser': browserMcpServer,
          'dashboards': dashboardsMcpServer,
        },
        agents: {
          'web-browser': {
            description: 'Web browsing specialist. Delegate any task that requires interacting with websites — navigating pages, filling forms, clicking buttons, extracting information, searching for products, changing settings on web services, or any multi-step web interaction. The browser should already be open (use browser_open first). This agent runs on a cheaper model and handles all browser interactions autonomously.',
            model: 'sonnet',
            tools: [
              'mcp__browser__browser_open',
              'mcp__browser__browser_snapshot',
              'mcp__browser__browser_click',
              'mcp__browser__browser_fill',
              'mcp__browser__browser_scroll',
              'mcp__browser__browser_wait',
              'mcp__browser__browser_press',
              'mcp__browser__browser_screenshot',
              'mcp__browser__browser_select',
              'mcp__browser__browser_hover',
              'mcp__browser__browser_run',
              'mcp__browser__browser_get_state',
              'WebSearch',
              'Read',
            ],
            prompt: WEB_BROWSER_AGENT_PROMPT,
            maxTurns: 50,
          },
        },
        // Handle AskUserQuestion via canUseTool callback (per SDK docs)
        canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal }) => {
          if (toolName === 'AskUserQuestion') {
            console.log('[canUseTool] AskUserQuestion called, toolUseID:', options.toolUseID);

            const questions = toolInput.questions as Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiSelect: boolean;
            }> | undefined;

            if (!questions?.length) {
              console.log('[canUseTool] No questions, allowing tool to proceed');
              return { behavior: 'allow' as const, updatedInput: toolInput };
            }

            const requestId = options.toolUseID || `ask-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            console.log('[canUseTool] Creating pending request:', requestId);

            try {
              // Block until user answers via our UI
              const answers = await inputManager.createPendingWithType<Record<string, string>>(
                requestId,
                'question',
                questions
              );

              console.log('[canUseTool] Got answers:', JSON.stringify(answers));

              // Return answers to Claude
              return {
                behavior: 'allow' as const,
                updatedInput: { questions, answers },
              };
            } catch (error) {
              console.log('[canUseTool] User declined:', error);
              return {
                behavior: 'deny' as const,
                message: error instanceof Error ? error.message : 'User declined to answer',
              };
            }
          }

          // Auto-approve other tools (we're in bypassPermissions mode)
          return { behavior: 'allow' as const, updatedInput: toolInput };
        },
        hooks: {
          PreToolUse: [
            {
              matcher: 'mcp__user-input__.*',
              hooks: [
                async (_input, toolUseId) => {
                  if (toolUseId) {
                    inputManager.setCurrentToolUseId(toolUseId);
                  }
                  return {};
                },
              ],
            },
          ],
        },
        systemPrompt: this.systemPromptAppend
          ? {
              type: 'preset',
              preset: 'claude_code',
              append: this.systemPromptAppend,
            }
          : {
              type: 'preset',
              preset: 'claude_code',
            },
      },
    });
  }

  /**
   * Initializes the abort controller and message queue, then creates a new query.
   */
  private initializeQuery(): void {
    this.abortController = new AbortController();
    this.messageQueue = new MessageQueue();
    this.queryInstance = this.createQuery();
    this.isReady = true;
  }

  async start(): Promise<void> {
    const isResuming = !!this.claudeSessionId;
    console.log(`[Session ${this.sessionId}] Starting SDK-based session`);
    console.log(`[Session ${this.sessionId}] ANTHROPIC_API_KEY set:`, !!process.env.ANTHROPIC_API_KEY);
    console.log(`[Session ${this.sessionId}] Working directory:`, this.workingDirectory);
    console.log(`[Session ${this.sessionId}] Resuming:`, isResuming, this.claudeSessionId);

    this.initializeQuery();
    this.emit('ready');

    // Start processing messages in the background
    this.processMessages();
  }

  private async processMessages(): Promise<void> {
    if (!this.queryInstance) return;

    this.isProcessing = true;
    let receivedResult = false;

    try {
      for await (const message of this.queryInstance) {
        // Capture Claude session ID from init message
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.claudeSessionId = message.session_id;
          // Update sessionId to the canonical Claude session ID so browser tools
          // broadcast to the correct session in the session manager
          this.sessionId = message.session_id;
          setCurrentBrowserSessionId(this.sessionId);
          console.log(`[Session ${this.sessionId}] Captured Claude session ID:`, this.claudeSessionId);
          this.emit('claude-session-id', this.claudeSessionId);
        }

        // Emit the SDK message
        console.log(`[Session ${this.sessionId}] SDK message:`, message.type,
          'subtype' in message ? (message as any).subtype : '');

        // Check for result message to know when processing is complete
        if (message.type === 'result') {
          receivedResult = true;
          // Enrich error results that have no useful error message
          const msg = message as any;
          if ((msg.subtype === 'error_during_execution' || msg.subtype === 'error') && !msg.error && !msg.message) {
            if (this.claudeSessionId) {
              msg.error = 'This session could not be resumed (it may have been corrupted by a previous crash). Please start a new session.';
            }
          }
          console.log(`[Session ${this.sessionId}] Query completed`);
        }

        this.emit('message', message);
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
        // Only emit synthetic result if the SDK didn't already send a real one
        // (e.g., SDK sends result error_during_execution then throws — don't overwrite)
        if (!receivedResult) {
          // Provide a user-friendly error message for known failure modes
          const errorMsg = error.message || '';
          let userError: string;
          if (errorMsg.includes('SIGKILL')) {
            userError = 'The agent process was killed due to running out of memory. Try starting a new session, or increase the container memory limit in settings.';
          } else if (errorMsg.includes('SIGTERM')) {
            userError = 'The agent process was terminated unexpectedly.';
          } else {
            userError = errorMsg || 'An unexpected error occurred';
          }
          // Emit synthetic result so downstream (WebSocket → message-persister → UI)
          // knows the query failed and can transition to error state
          const isFatal = errorMsg.includes('SIGKILL') || errorMsg.includes('SIGTERM');
          this.emit('message', {
            type: 'result',
            subtype: 'error',
            error: userError,
            session_id: this.claudeSessionId || this.sessionId,
            ...(isFatal && { fatal: true }),
          });
        }
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
    // Auto-restart session if not running
    if (!this.messageQueue || !this.isReady) {
      console.log(`[Session ${this.sessionId}] Session not running, restarting...`);
      await this.restart();
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
    this.messageQueue!.push(message);
  }

  // Restart the session (used when session exits and user sends a new message)
  private async restart(): Promise<void> {
    console.log(`[Session ${this.sessionId}] Restarting session`);
    this.initializeQuery();
    this.processMessages();
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
    this.initializeQuery();
    this.processMessages();
  }
}
