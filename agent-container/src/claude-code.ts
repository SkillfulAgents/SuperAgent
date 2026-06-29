import { query, Query, SDKUserMessage, type HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { EffortLevel } from './types';
import { createUserInputMcpServer, createBrowserMcpServer, createComputerUseMcpServer, createDashboardsMcpServer, createAgentsMcpServer, createChatMcpServer } from './mcp-server';
import { createBrowserTools } from './tools/browser';
import { renameBrowserSession } from './browser-state';
import { computerUseTools } from './tools/computer-use';
import { fileHooks, resolveToolFilePath } from './file-hooks';

/**
 * `Query` plus the `cancel_async_message` control request, which drops a queued
 * (not yet executed) user message from the CLI's command queue by uuid.
 *
 * This is a sanctioned protocol feature — announced in the Agent SDK changelog
 * (v0.2.76: "Added `cancel_async_message` control subtype to drop a queued user
 * message by UUID before execution") and carrying an exported, doc-commented wire
 * type `SDKControlCancelAsyncMessageRequest` ("Drops a pending async user message
 * from the command queue by uuid. No-op if already dequeued for execution.").
 * The convenience method is implemented in sdk.mjs but deliberately omitted from
 * the public `Query` typings, so we declare it here. `cancelQueuedMessage` guards
 * its presence at runtime (and queued-message-cancel.test.ts asserts the real SDK
 * still exposes it) so an SDK bump that renames/removes it fails loudly instead of
 * silently degrading every cancel to "already picked up".
 */
type QueryWithAsyncCancel = Query & {
  cancelAsyncMessage(messageUuid: string): Promise<boolean>;
};

/** Generate prefixed MCP tool names from a tools array, optionally excluding some by name. */
function mcpToolNames(
  serverName: string,
  tools: { name: string }[],
  exclude?: string[],
): string[] {
  const excludeSet = exclude ? new Set(exclude) : null
  return tools
    .filter(t => !excludeSet || !excludeSet.has(t.name))
    .map(t => `mcp__${serverName}__${t.name}`)
}

function shouldDenyMainModelTool(input: HookInput, unsupportedTools: string[]): boolean {
  if (input.hook_event_name !== 'PreToolUse') return false;
  return !input.agent_id && unsupportedTools.includes(input.tool_name);
}

import { inputManager } from './input-manager';
import { sanitizeMcpName } from './sanitize-mcp-name';

// Prefix for system-injected user messages that should be hidden in the UI.
// Keep in sync with SYSTEM_MESSAGE_PREFIX in src/renderer/components/messages/message-list.tsx
const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] ';

// Defaults for `${VAR}` placeholders in prompt files. Mirror values the host
// (base-container-client.ts) sets, so out-of-host runs render sensibly.
const PROMPT_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_CONFIG_DIR: '/workspace/.claude',
};

function interpolateEnv(template: string): string {
  return template.replace(/\$\{(\w+)\}/g, (match, name) => {
    return process.env[name] || PROMPT_ENV_DEFAULTS[name] || match;
  });
}

function loadPrompt(filename: string): string {
  return interpolateEnv(fs.readFileSync(path.join(__dirname, filename), 'utf-8'));
}

const SYSTEM_PROMPT = loadPrompt('system-prompt.md');
const WEB_BROWSER_AGENT_PROMPT = loadPrompt('web-browser-agent-prompt.md');
const COMPUTER_USE_AGENT_PROMPT = loadPrompt('computer-use-agent-prompt.md');
const DASHBOARD_BUILDER_AGENT_PROMPT = loadPrompt('dashboard-builder-agent-prompt.md');

interface RemoteMcpConfig {
  id: string;
  name: string;
  proxyUrl: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

/**
 * Parses remote MCP server configs from the REMOTE_MCPS env var.
 */
function parseRemoteMcps(): RemoteMcpConfig[] {
  const raw = process.env.REMOTE_MCPS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RemoteMcpConfig[];
  } catch {
    return [];
  }
}

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
 * Generates the full system prompt from the SuperAgent prompt plus dynamic
 * sections (connected accounts, env vars, user instructions).
 */
function generateSystemPrompt(
  availableEnvVars?: string[],
  userSystemPrompt?: string,
  modelPromptHints?: string[],
): string {
  const sections: string[] = [];

  sections.push(SYSTEM_PROMPT);

  if (modelPromptHints?.length) {
    sections.push(`## Model-Specific Instructions

${modelPromptHints.map(hint => `- ${hint}`).join('\n')}`);
  }

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

  // Remote MCP servers section
  const remoteMcps = parseRemoteMcps();
  if (remoteMcps.length > 0) {
    const mcpSections: string[] = [];
    for (const mcp of remoteMcps) {
      const toolNames = mcp.tools.map(t => t.name);
      const sanitizedName = sanitizeMcpName(mcp.name);
      mcpSections.push(
        `### ${mcp.name}\nTools: ${toolNames.join(', ')}\nUse these tools via mcp__${sanitizedName}__<tool_name>`
      );
    }
    sections.push(`## Remote MCP Servers (Available)

The following remote MCP servers are connected and their tools are available for use:

${mcpSections.join('\n\n')}`);
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

  // Remove a buffered message by uuid. Rarely hits — the SDK drains this
  // queue eagerly — but covers the window before the SDK pulls it.
  remove(uuid: string): boolean {
    const index = this.queue.findIndex((m) => m.uuid === uuid);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
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

// Module-level reference to the current process (one per container)
let currentProcess: ClaudeCodeProcess | null = null;
export function getCurrentProcess(): ClaudeCodeProcess | null {
  return currentProcess;
}

export interface ClaudeCodeProcessOptions {
  sessionId: string;
  workingDirectory: string;
  claudeSessionId?: string;
  userSystemPrompt?: string;
  modelPromptHints?: string[];
  /** Host-resolved tools this model can't use (e.g. WebSearch/WebFetch when web search is unsupported). */
  unsupportedTools?: string[];
  availableEnvVars?: string[];
  model?: string;
  browserModel?: string;
  dashboardBuilderModel?: string;
  maxOutputTokens?: number;
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  customEnvVars?: Record<string, string>;
  effort?: EffortLevel;
}

export class ClaudeCodeProcess extends EventEmitter {
  private queryInstance: Query | null = null;
  private messageQueue: MessageQueue | null = null;
  private abortController: AbortController | null = null;
  private sessionId: string;
  private workingDirectory: string;
  private claudeSessionId: string | null;
  private systemPrompt: string;
  private model: string | undefined;
  private browserModel: string | undefined;
  private dashboardBuilderModel: string | undefined;
  private unsupportedTools: string[];
  private maxOutputTokens: number | undefined;
  private maxThinkingTokens: number | undefined;
  private maxTurns: number | undefined;
  private maxBudgetUsd: number | undefined;
  private customEnvVars: Record<string, string> | undefined;
  private effort: EffortLevel | undefined;
  private isReady: boolean = false;
  private isProcessing: boolean = false;
  private userMessageCount: number = 0;
  private isResumedSession: boolean;
  public slashCommands: { name: string; description: string; argumentHint: string }[] = [];

  constructor(options: ClaudeCodeProcessOptions) {
    super();
    this.sessionId = options.sessionId;
    this.workingDirectory = options.workingDirectory;
    this.claudeSessionId = options.claudeSessionId || null;
    this.isResumedSession = !!options.claudeSessionId;
    // The host resolves selections to a concrete wire id (family aliases →
    // their latest concrete id) before they reach the container, so we pass
    // the model straight through — including '/'-style OpenRouter ids.
    this.model = options.model;
    this.browserModel = options.browserModel;
    this.dashboardBuilderModel = options.dashboardBuilderModel;
    this.unsupportedTools = options.unsupportedTools ?? [];
    this.maxOutputTokens = options.maxOutputTokens;
    this.maxThinkingTokens = options.maxThinkingTokens;
    this.maxTurns = options.maxTurns;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.customEnvVars = options.customEnvVars;
    this.effort = options.effort;
    this.systemPrompt = generateSystemPrompt(
      options.availableEnvVars,
      options.userSystemPrompt,
      options.modelPromptHints
    );
    // Set module-level reference for tools that need access to the process
    currentProcess = this;
  }

  /**
   * Interrupt and restart the query after MCP approval.
   * Called by request_remote_mcp tool after user approval. The env var REMOTE_MCPS
   * is already updated by the host. We can't inject tools into the running query
   * mid-stream, so we interrupt the current query and restart. The new query
   * picks up the MCP server from the env var, and we send a continuation message
   * so the model proceeds with the original request using the newly available tools.
   */
  addRemoteMcpServer(name: string): void {
    const sanitizedName = sanitizeMcpName(name);
    console.log(`[ClaudeCodeProcess] MCP server "${sanitizedName}" approved, scheduling interrupt to inject tools`);

    // Defer to run after the tool result is delivered back to the CLI.
    // interrupt() aborts the current query, waits for it to stop, then restarts
    // with a new query that includes the MCP from the REMOTE_MCPS env var.
    setTimeout(async () => {
      try {
        console.log(`[ClaudeCodeProcess] Interrupting for MCP injection: ${sanitizedName}`);
        await this.interrupt();
        console.log(`[ClaudeCodeProcess] Interrupt complete, sending MCP continuation for: ${sanitizedName}`);
        await this.sendMessage(
          `${SYSTEM_MESSAGE_PREFIX}The remote MCP server "${name}" has been fully registered and its tools are now available. Please proceed to use them to fulfill the original request. Do not request the MCP server again.`
        );
      } catch (err) {
        console.error(`[ClaudeCodeProcess] MCP injection via interrupt failed:`, err);
      }
    }, 0);
  }

  /**
   * Builds HTTP MCP server configs from the REMOTE_MCPS env var.
   * Each remote MCP is configured as an HTTP transport pointing to the proxy URL.
   */
  private buildRemoteMcpServers(): Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> {
    const remoteMcps = parseRemoteMcps();
    const configs: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {};
    const proxyToken = process.env.PROXY_TOKEN;

    for (const mcp of remoteMcps) {
      const sanitizedName = sanitizeMcpName(mcp.name);
      configs[sanitizedName] = {
        type: 'http',
        url: mcp.proxyUrl,
        headers: proxyToken ? { 'Authorization': `Bearer ${proxyToken}` } : undefined,
      };
    }

    return configs;
  }

  /**
   * Creates a new query instance with the standard configuration.
   * Used by start(), restart(), and interrupt() to avoid duplication.
   */
  private createQuery(): Query {
    const remoteMcpConfigs = this.buildRemoteMcpServers();
    const remoteMcpToolPatterns = Object.keys(remoteMcpConfigs).map(name => `mcp__${name}__*`);

    // Browser tools are bound per-session via a getter read on every request:
    // this.sessionId changes when the query (re)starts, and a module-global id
    // shared across sessions stranded browser calls on the ownership lock.
    const browserMcpTools = createBrowserTools(() => this.sessionId);

    console.log(`[Session ${this.sessionId}] createQuery: model=${this.model ?? '(default)'}, effort=${this.effort ?? '(default)'}`);

    return query({
      prompt: this.messageQueue!,
      options: {
        model: this.model,
        cwd: this.workingDirectory,
        abortController: this.abortController!,
        resume: this.claudeSessionId || undefined,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        agentProgressSummaries: true,
        // Expose the dynamic-workflows `Workflow` tool. In headless/SDK mode the
        // feature is hidden unless explicitly opted in (there is no interactive
        // /config to record consent, so the SDK defaults it OFF). There is no
        // enable env var — only CLAUDE_CODE_DISABLE_WORKFLOWS — so we set it via
        // the `settings` flag layer (`enableWorkflows` is a Settings field, not a
        // top-level Option). Without it the model can't see a Workflow tool at all
        // and falls back to simulating with Agent subagents.
        settings: { enableWorkflows: true },
        settingSources: ['user', 'project'],
        allowedTools: ['Skill', 'Task', 'Agent', ...remoteMcpToolPatterns],
        disallowedTools: [
          'TaskOutput', 'Monitor',
          'CronCreate', 'CronDelete', 'CronList',
          'ScheduleWakeup', 'RemoteTrigger', 'PushNotification',
          'EnterWorktree', 'ExitWorktree',
        ],
        // Request summarized thinking so reasoning text streams to the UI. Without an
        // explicit `display`, Opus 4.8/4.7 default to `omitted` — thinking_delta events
        // arrive empty (only a signature), so the UI can show "Thinking" but no text.
        thinking: this.maxThinkingTokens
          ? { type: 'enabled', budgetTokens: this.maxThinkingTokens, display: 'summarized' }
          : { type: 'adaptive', display: 'summarized' },
        ...(this.maxTurns && { maxTurns: this.maxTurns }),
        ...(this.maxBudgetUsd && { maxBudgetUsd: this.maxBudgetUsd }),
        ...(this.effort && { effort: this.effort }),
        env: {
          // Agent SDK 0.2.113+ replaces process.env with options.env instead of
          // overlaying it, so we must spread process.env explicitly or the Claude
          // subprocess loses PATH, HOME, ANTHROPIC_API_KEY, connected-account env
          // vars, and anything else set on the container.
          ...process.env,
          ...this.customEnvVars,
          // Emit `session_state_changed` system events (idle/running/requires_action).
          // The host treats `idle` as the authoritative end-of-session signal (a
          // 'result' alone doesn't end it — queued messages can keep the run going).
          // server.ts announces this capability on WebSocket connect — keep the two
          // in sync. See message-persister.ts.
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
          // Explicit maxOutputTokens setting takes precedence over custom env var
          ...(this.maxOutputTokens && { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(this.maxOutputTokens) }),
        },
        mcpServers: {
          'user-input': createUserInputMcpServer(),
          'browser': createBrowserMcpServer(browserMcpTools),
          'dashboards': createDashboardsMcpServer(),
          'agents': createAgentsMcpServer(() => this.sessionId),
          'chat': createChatMcpServer(),
          ...(['darwin', 'win32'].includes(process.env.HOST_PLATFORM || '') ? { 'computer-use': createComputerUseMcpServer() } : {}),
          ...remoteMcpConfigs,
        },
        agents: {
          'web-browser': {
            description: 'Web browsing specialist. Delegate any task that requires interacting with websites — navigating pages, filling forms, clicking buttons, extracting information, searching for products, changing settings on web services, or any multi-step web interaction. The browser should already be open (use browser_open first). This agent runs on a cheaper model and handles all browser interactions autonomously.',
            // Host-resolved concrete wire id for the browser model (any provider/
            // model the user configured); AgentDefinition.model is a plain string.
            // Fall back to the main model — never a hardcoded Claude alias, which
            // would force Anthropic on non-Anthropic providers.
            model: this.browserModel || this.model,
            tools: [
              ...mcpToolNames('browser', browserMcpTools),
              'WebSearch',
              'Read',
              'mcp__user-input__request_file',
              'mcp__user-input__request_browser_input',
            ],
            prompt: WEB_BROWSER_AGENT_PROMPT,
            maxTurns: 500,
          },
          'dashboard-builder': {
            description: 'Dashboard building specialist. Delegate any task that involves creating, editing, or debugging dashboards (artifacts) — designing layouts, writing HTML/CSS/JS or React code, adding charts, connecting to data sources, fixing visual issues, or iterating on dashboard design. This agent handles the full build cycle: scaffolding, coding, starting, and verifying via screenshots.',
            // Host-resolved dashboard-builder model (its own setting); falls back to
            // the main model rather than a hardcoded Claude alias.
            model: this.dashboardBuilderModel || this.model,
            tools: [
              'mcp__dashboards__create_dashboard',
              'mcp__dashboards__start_dashboard',
              'mcp__dashboards__list_dashboards',
              'mcp__dashboards__get_dashboard_logs',
              'Read',
              'Write',
              'Edit',
              'Bash',
            ],
            prompt: DASHBOARD_BUILDER_AGENT_PROMPT,
            maxTurns: 200,
          },
          ...(['darwin', 'win32'].includes(process.env.HOST_PLATFORM || '') ? {
            'computer-use': {
              description: 'Desktop automation specialist for macOS. Delegate any task that requires interacting with native applications — clicking buttons, filling forms, reading screen content, navigating menus, or any multi-step app interaction. The app should already be launched and grabbed (use computer_launch first). This agent runs on a cheaper model and handles all app interactions autonomously.',
              // Cheap tier (browser model); falls back to the main model — never a
              // hardcoded Claude alias.
              model: this.browserModel || this.model,
              tools: [
                ...mcpToolNames('computer-use', computerUseTools, ['computer_launch', 'computer_quit', 'computer_ungrab']),
                'Read',
              ],
              prompt: COMPUTER_USE_AGENT_PROMPT,
              maxTurns: 500,
            },
          } : {}),
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

            const requestId = options.toolUseID || `ask-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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

          // For MCP user-input tools called by subagents, set the toolUseId
          // so the tool handler can consume it. PreToolUse hooks may not fire
          // for subagent tool calls, so we set it here as well.
          // TODO: Race condition — if both canUseTool and PreToolUse fire for
          // the same tool call, the last write wins (setCurrentToolUseId is
          // not additive). This is acceptable because they write the same ID,
          // but if two user-input tools fire concurrently the first ID could
          // be overwritten before consumeCurrentToolUseId is called.
          if ((toolName.startsWith('mcp__user-input__') || toolName.startsWith('mcp__computer-use__')) && options.toolUseID) {
            inputManager.setCurrentToolUseId(options.toolUseID);
          }

          // Auto-approve other tools (we're in bypassPermissions mode)
          return { behavior: 'allow' as const, updatedInput: toolInput };
        },
        hooks: {
          PreToolUse: [
            {
              matcher: '.*',
              hooks: [
                async (input) => {
                  if (shouldDenyMainModelTool(input, this.unsupportedTools)) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: 'The selected main model does not support this tool.',
                      },
                    };
                  }
                  return {};
                },
              ],
            },
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
              matcher: 'mcp__computer-use__.*',
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
              matcher: 'mcp__agents__create_agent',
              hooks: [
                async () => {
                  if (this.userMessageCount <= 1 && !this.isResumedSession) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason:
                          'This is the first message in the session. When users say "create an agent to..." they almost always mean they want YOU (the current agent) to to be this agent. Please re-read the user\'s message — they are likely asking you to build this agent in your current workspace - not as a seperate one. Only create a new agent if the user explicitly and unambiguously asks to set up a separate, reusable agent definition.',
                      },
                    };
                  }
                  return {};
                },
              ],
            },
            {
              matcher: 'Write',
              hooks: [
                async (input) => {
                  const toolInput = (input as any).tool_input as Record<string, unknown>;
                  const filePath = resolveToolFilePath(toolInput, this.workingDirectory);
                  if (!filePath) return {};
                  for (const hook of fileHooks) {
                    if (!hook.matches(filePath)) continue;
                    const result = hook.onWrite(filePath, toolInput.content as string);
                    if (result.error) {
                      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: result.error } };
                    }
                    if (result.warning) {
                      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, additionalContext: result.warning } };
                    }
                  }
                  return {};
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'Read',
              hooks: [
                async (input) => {
                  const toolInput = (input as any).tool_input as Record<string, unknown>;
                  const filePath = resolveToolFilePath(toolInput, this.workingDirectory);
                  if (!filePath) return {};
                  for (const hook of fileHooks) {
                    if (!hook.matches(filePath)) continue;
                    const result = hook.onRead(filePath);
                    if (result.additionalContext) {
                      return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: result.additionalContext } };
                    }
                  }
                  return {};
                },
              ],
            },
            {
              matcher: 'Edit',
              hooks: [
                async (input) => {
                  const toolInput = (input as any).tool_input as Record<string, unknown>;
                  const filePath = resolveToolFilePath(toolInput, this.workingDirectory);
                  if (!filePath) return {};
                  for (const hook of fileHooks) {
                    if (!hook.matches(filePath)) continue;
                    try {
                      const content = await fs.promises.readFile(filePath, 'utf-8');
                      const result = hook.onEdit(filePath, content);
                      if (result.error) {
                        return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: `Warning: ${result.error}` } };
                      }
                      if (result.warning) {
                        return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: result.warning } };
                      }
                    } catch {
                      // File may not exist yet after edit — skip
                    }
                  }
                  return {};
                },
              ],
            },
          ],
        },
        systemPrompt: this.systemPrompt,
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
    // Tracks whether the MOST RECENT result was an error. The catch below emits
    // a synthetic error result only when the SDK hasn't already reported this
    // failure — but a SUCCESS result must NOT suppress it. In streaming-input
    // mode this query lives across many turns, so if the process dies after a
    // success (e.g. while a queued message keeps it running) there would be no
    // result for that work and the host, which waits for the authoritative idle,
    // would stay "working" forever. Keying on the last result's error-ness (not
    // "any result seen") also resets per turn: a success clears it.
    let lastResultWasError = false;

    try {
      for await (const message of this.queryInstance) {
        // Capture Claude session ID from init message
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.claudeSessionId = message.session_id;
          // Update sessionId to the canonical Claude session ID so browser tools
          // broadcast to the correct session in the session manager
          const previousSessionId = this.sessionId;
          this.sessionId = message.session_id;
          // If this session already owns the browser under its previous id
          // (query restart mid-browse), re-key the lock or every subsequent
          // browser call 409s against our own browser.
          if (previousSessionId !== this.sessionId && renameBrowserSession(previousSessionId, this.sessionId)) {
            console.log(`[Session ${this.sessionId}] Re-keyed browser lock from ${previousSessionId}`);
          }
          console.log(`[Session ${this.sessionId}] Captured Claude session ID:`, this.claudeSessionId);
          this.emit('claude-session-id', this.claudeSessionId);
          // Fetch rich slash command info from SDK
          try {
            const cmds = await this.queryInstance!.supportedCommands();
            this.slashCommands = cmds.map(c => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
          } catch (err) {
            console.error(`[Session ${this.sessionId}] Failed to fetch slash commands:`, err);
          }
          this.emit('init-complete');
        }

        // Emit the SDK message
        console.log(`[Session ${this.sessionId}] SDK message:`, message.type,
          'subtype' in message ? (message as any).subtype : '');




        // Check for result message to know when processing is complete
        if (message.type === 'result') {
          const msg = message as any;
          lastResultWasError =
            msg.subtype === 'error_during_execution' ||
            msg.subtype === 'error' ||
            msg.is_error === true;
          // Enrich error results that have no useful error message
          if (lastResultWasError && !msg.error && !msg.message && this.claudeSessionId) {
            msg.error = 'This session could not be resumed (it may have been corrupted by a previous crash). Please start a new session.';
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
        // Only emit a synthetic result if the SDK hasn't already reported this
        // failure with an error result (e.g. it sends error_during_execution
        // then throws — don't double-report). A prior SUCCESS does not count:
        // a crash after a successful turn still needs to surface so the host
        // stops waiting.
        if (!lastResultWasError) {
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

  async sendMessage(content: string, uuid?: UUID, options?: { effort?: EffortLevel; model?: string; shouldQuery?: boolean }): Promise<void> {
    const effort = options?.effort;
    const model = options?.model;

    // Treat undefined stored effort as 'high' so pre-existing sessions (created before
    // this feature) don't trigger a spurious restart on their first post-upgrade message.
    const currentEffort: EffortLevel = this.effort ?? 'high';
    const effortChanged = effort !== undefined && effort !== currentEffort;

    // The host resolves selections to concrete wire ids before sending, so
    // compare ids directly. Switching between two pinned versions of a family
    // (e.g. opus-4-6 -> opus-4-7) is now a real, intentional switch.
    const modelChanged = model !== undefined && model !== this.model;

    if (effortChanged) {
      this.effort = effort;
    }
    if (modelChanged) {
      this.model = model;
    }

    if (!this.messageQueue || !this.isReady) {
      // Cold session — first init will pick up the (possibly new) effort/model values.
      console.log(`[Session ${this.sessionId}] Session not running, restarting...`);
      await this.restart();
    } else if (effortChanged) {
      // Effort can only be set at query creation time — the SDK has no setEffort
      // facility — so any effort change forces an interrupt + re-query. The new
      // model (if also changed) is picked up by the same restart.
      const reasons: string[] = [`effort ${currentEffort} -> ${effort}`];
      if (modelChanged) reasons.push(`model -> ${this.model}`);
      console.log(`[Session ${this.sessionId}] Restarting query (${reasons.join(', ')})`);
      await this.interrupt();
    } else if (modelChanged && this.queryInstance) {
      // Model-only change — use the SDK's dynamic setModel() so the running query
      // is reused and only subsequent turns are served by the new model. No
      // interrupt, no resume replay.
      console.log(`[Session ${this.sessionId}] Switching model dynamically -> ${this.model}`);
      try {
        await this.queryInstance.setModel(this.model);
      } catch (err) {
        // setModel can fail (e.g. transport not in streaming mode). Fall back to
        // the conservative restart path so the new model still takes effect.
        console.warn(`[Session ${this.sessionId}] setModel failed, falling back to restart:`, err);
        await this.interrupt();
      }
    }

    // Create SDK user message format
    const shouldQuery = options?.shouldQuery;
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
      ...(uuid ? { uuid } : {}),
      ...(shouldQuery !== undefined ? { shouldQuery } : {}),
    };

    if (!content.startsWith(SYSTEM_MESSAGE_PREFIX)) {
      this.userMessageCount++;
    }
    console.log(`[Session ${this.sessionId}] Sending message (userMessageCount=${this.userMessageCount}):`, content.substring(0, 100));
    this.messageQueue!.push(message);
  }

  /**
   * Cancel a queued (not yet picked up) message by the uuid it was sent with.
   * Returns true when the message was dropped before the agent saw it.
   */
  async cancelQueuedMessage(uuid: UUID): Promise<boolean> {
    // Window before the SDK pulled it from our queue
    if (this.messageQueue?.remove(uuid)) {
      console.log(`[Session ${this.sessionId}] Cancelled queued message (local buffer):`, uuid);
      return true;
    }
    if (!this.queryInstance) return false;
    // The message already reached the CLI's command queue — drop it there via
    // the cancel_async_message control request (see QueryWithAsyncCancel). No-op
    // (false) if it was already dequeued for execution; verified against CLI
    // 2.1.170, where a cancelled message leaves no transcript trace (the queue
    // records only the enqueue/dequeue operations).
    const cancellable = this.queryInstance as QueryWithAsyncCancel;
    if (typeof cancellable.cancelAsyncMessage !== 'function') {
      // The untyped SDK method is gone (renamed/removed by an upgrade). Fail
      // safe: report "too late", so the caller leaves the ghost to materialize.
      console.warn(`[Session ${this.sessionId}] cancelAsyncMessage unavailable in this SDK build`);
      return false;
    }
    try {
      const cancelled = await cancellable.cancelAsyncMessage(uuid);
      console.log(`[Session ${this.sessionId}] cancelAsyncMessage(${uuid}) ->`, cancelled);
      return cancelled;
    } catch (error) {
      console.warn(`[Session ${this.sessionId}] cancelAsyncMessage failed:`, error);
      return false;
    }
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
