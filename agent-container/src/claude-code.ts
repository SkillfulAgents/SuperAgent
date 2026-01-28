import { query, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { userInputMcpServer } from './mcp-server';
import { inputManager } from './input-manager';

// Load platform system prompt from file
const PLATFORM_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system-prompt.md'),
  'utf-8'
);

/**
 * Parses connected account environment variables to extract account information.
 * Connected account env vars are named CONNECTED_ACCOUNT_<TOOLKIT> and contain
 * JSON objects mapping account names to tokens.
 */
function parseConnectedAccounts(envVars?: string[]): Map<string, string[]> {
  const accounts = new Map<string, string[]>();

  if (!envVars) return accounts;

  for (const envVar of envVars) {
    if (envVar.startsWith('CONNECTED_ACCOUNT_')) {
      const toolkit = envVar.replace('CONNECTED_ACCOUNT_', '').toLowerCase();
      const value = process.env[envVar];

      if (value) {
        try {
          const parsed = JSON.parse(value);
          const accountNames = Object.keys(parsed);
          if (accountNames.length > 0) {
            accounts.set(toolkit, accountNames);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
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

  // Parse connected accounts for explicit listing
  const connectedAccounts = parseConnectedAccounts(availableEnvVars);

  // Separate connected account env vars from regular secrets
  const regularEnvVars = (availableEnvVars || []).filter(
    name => !name.startsWith('CONNECTED_ACCOUNT_')
  );

  // Connected accounts section (explicit listing of what's already available)
  if (connectedAccounts.size > 0) {
    const accountSections: string[] = [];

    for (const [toolkit, accountNames] of connectedAccounts) {
      const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
      accountSections.push(`### ${displayName}\n${accountNames.map(name => `- ${name}`).join('\n')}`);
    }

    sections.push(`## Connected Accounts (Already Available)

**IMPORTANT: You already have access to the following connected accounts. Do NOT request access to these - you already have it!**

${accountSections.join('\n\n')}

Access tokens are available in environment variables named \`CONNECTED_ACCOUNT_<TOOLKIT>\` (e.g., \`CONNECTED_ACCOUNT_GMAIL\`).`);
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
}

export class ClaudeCodeProcess extends EventEmitter {
  private queryInstance: Query | null = null;
  private messageQueue: MessageQueue | null = null;
  private abortController: AbortController | null = null;
  private sessionId: string;
  private workingDirectory: string;
  private claudeSessionId: string | null;
  private systemPromptAppend: string | undefined;
  private isReady: boolean = false;
  private isProcessing: boolean = false;

  constructor(options: ClaudeCodeProcessOptions) {
    super();
    this.sessionId = options.sessionId;
    this.workingDirectory = options.workingDirectory;
    this.claudeSessionId = options.claudeSessionId || null;
    this.systemPromptAppend = generateSystemPromptAppend(
      options.availableEnvVars,
      options.userSystemPrompt
    );
  }

  /**
   * Creates a new query instance with the standard configuration.
   * Used by start(), restart(), and interrupt() to avoid duplication.
   */
  private createQuery(): Query {
    return query({
      prompt: this.messageQueue!,
      options: {
        cwd: this.workingDirectory,
        abortController: this.abortController!,
        resume: this.claudeSessionId || undefined,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        settingSources: ['user', 'project'],
        allowedTools: ['Skill'],
        mcpServers: {
          'user-input': userInputMcpServer,
        },
        // Handle AskUserQuestion via canUseTool callback (per SDK docs)
        canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
          if (toolName === 'AskUserQuestion') {
            console.log('[canUseTool] AskUserQuestion called');

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

            // Get the tool_use_id that was captured by the PreToolUse hook
            const toolUseId = inputManager.consumeCurrentToolUseId();
            if (!toolUseId) {
              console.log('[canUseTool] No toolUseId available, generating one');
            }
            const requestId = toolUseId || `ask-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
            {
              // Capture tool_use_id for AskUserQuestion so canUseTool can use it
              matcher: 'AskUserQuestion',
              hooks: [
                async (_input, toolUseId) => {
                  if (toolUseId) {
                    console.log('[AskUserQuestion PreToolUse] Capturing toolUseId:', toolUseId);
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
