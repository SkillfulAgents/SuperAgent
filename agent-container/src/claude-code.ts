import { query, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { UUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { EffortLevel, SpeedLevel } from './types';
import { createUserInputMcpServer, createBrowserMcpServer, createComputerUseMcpServer, createDashboardsMcpServer, createAgentsMcpServer, createChatMcpServer, createWebMcpServer } from './mcp-server';
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
import { inputManager } from './input-manager';
import { sanitizeMcpName } from './sanitize-mcp-name';
import { withAgentAttributionHeaders, withSpeedHeader } from './attribution-headers';
import { renderPrompt } from './render-prompt';
import type { AgentCapabilityPolicies } from './types';
import {
  applyCapabilityPolicies,
  blockBoundaryChanged,
  blockedCapabilityMessage,
  policyFor,
  type Capability,
} from './capability-policies';
import { createCapabilityGateHook, CAPABILITY_REVIEW_HOOK_TIMEOUT_S } from './capability-gate-hook';

// Prefix for system-injected user messages that should be hidden in the UI.
// Keep in sync with SYSTEM_MESSAGE_PREFIX in src/renderer/components/messages/message-list.tsx
const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] ';

export const AGENT_BROWSER_BASH_WARNING =
  'STRONG WARNING: This Bash command is probably bypassing Gamut\'s browser integration. For website work, use the dedicated mcp__browser__browser_* tools; if they are deferred, load their exact full names with ToolSearch. The Bash command is still allowed, but continue with agent-browser only when the dedicated browser tools genuinely cannot perform the operation.';

export function startsWithAgentBrowserCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return /^(?:agent-browser|which\s+agent-browser)(?=$|[\s;&|])/.test(command.trimStart());
}

// Default values for system-prompt template vars when the host env is unset.
// Mirror values the host (base-container-client.ts) sets, so out-of-host runs
// render sensibly.
const PROMPT_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_CONFIG_DIR: '/workspace/.claude',
};

function loadPrompt(filename: string): string {
  return fs.readFileSync(path.join(__dirname, filename), 'utf-8');
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

/** One toolkit's connected accounts, as the template's `connectedAccounts` list. */
interface ConnectedAccountGroup {
  displayName: string;
  entries: Array<{ name: string; id: string }>;
}

/** One remote MCP server, as the template's `remoteMcps` list. */
interface RemoteMcpView {
  name: string;
  tools: string;
  sanitizedName: string;
}

function connectedAccountGroups(): ConnectedAccountGroup[] {
  return [...parseConnectedAccounts()].map(([toolkit, entries]) => ({
    displayName: toolkit.charAt(0).toUpperCase() + toolkit.slice(1),
    entries,
  }));
}

function remoteMcpViews(): RemoteMcpView[] {
  return parseRemoteMcps().map(mcp => ({
    name: mcp.name,
    tools: mcp.tools.map(t => t.name).join(', '),
    sanitizedName: sanitizeMcpName(mcp.name),
  }));
}

/** Env vars the agent may read directly — the proxy's own vars are documented separately. */
function agentEnvVars(availableEnvVars?: string[]): string[] {
  const proxyEnvVars = new Set(['PROXY_BASE_URL', 'PROXY_TOKEN', 'CONNECTED_ACCOUNTS']);
  return (availableEnvVars || []).filter(
    name => !name.startsWith('CONNECTED_ACCOUNT_') && !proxyEnvVars.has(name)
  );
}

/** Computer-use tools and the request_script_run tool only exist on desktop hosts. */
// Interrupt receipt from Query.interrupt() (SDK >= 0.3.205, advertised by the
// interrupt_receipt_v1 capability): `still_queued` lists the uuids of async
// user messages that would SURVIVE a graceful interrupt and still run. Older
// CLIs resolve with an empty success payload (undefined / no field) — treat
// that as "nothing known", never as "nothing queued".
const interruptReceiptSchema = z.object({
  still_queued: z.array(z.string()).optional().catch(undefined),
});

export function stillQueuedFromReceipt(receipt: unknown): string[] {
  const parsed = interruptReceiptSchema.safeParse(receipt);
  if (!parsed.success) return [];
  return parsed.data.still_queued ?? [];
}

export interface InterruptOutcome {
  interrupted: boolean;
  // Uuids of queued user messages that died with this interrupt — never picked
  // up by the agent. The same uuids are also emitted on the message stream as
  // synthetic `command_lifecycle` frames with state 'discarded'.
  discardedUuids: string[];
}

// An error result with no human-readable text anywhere gets the resume-failure
// fallback copy. `result` counts as text: the modern error shape (is_error:true
// with terminal_reason, e.g. an api_error from a bad model id) puts the real
// explanation there — stomping a synthetic "session corrupted" message next to
// it misleads the host into showing the wrong error. Gracefully interrupted
// turns (terminal_reason aborted_*) are textless BY DESIGN — they are a
// deliberate stop, not a resume failure, and must not get the copy either.
export function resultNeedsResumeErrorFallback(msg: {
  error?: unknown;
  message?: unknown;
  result?: unknown;
  terminal_reason?: unknown;
}): boolean {
  if (msg.terminal_reason === 'aborted_tools' || msg.terminal_reason === 'aborted_streaming') return false;
  return !msg.error && !msg.message && !msg.result;
}

export function isComputerUseHost(): boolean {
  return ['darwin', 'win32'].includes(process.env.HOST_PLATFORM || '');
}

/**
 * The template renders every section itself; this bag carries only data. Each
 * list is paired with a `has*` boolean because a Mustache list section repeats
 * its body per item and so cannot host the section's heading. A string needs no
 * such pair: a non-empty string renders its section body exactly once.
 */
export interface SystemPromptVars {
  CLAUDE_CONFIG_DIR: string;
  webSearchToolName: string;
  webFetchToolName: string;
  subagentsEnabled: boolean;
  composioTriggers: boolean;
  webhookEndpoints: boolean;
  anyTriggers: boolean;
  computerUse: boolean;
  hasModelHints: boolean;
  modelHints: string[];
  hasConnectedAccounts: boolean;
  connectedAccounts: ConnectedAccountGroup[];
  hasRemoteMcps: boolean;
  remoteMcps: RemoteMcpView[];
  hasEnvVars: boolean;
  envVars: string[];
  userInstructions: string;
}

/**
 * Builds the variable bag consumed by the system-prompt template: the two
 * trigger-availability gates and the computer-use host gate read from the
 * environment, the labels of whichever native web tools a vendor replaced, the
 * config dir, and the data behind the sections that only render for some agents.
 */
export function buildSystemPromptVars(
  availableEnvVars?: string[],
  userSystemPrompt?: string,
  modelPromptHints?: string[],
  webSearchProvider?: string,
  webFetchProvider?: string,
  capabilityPolicies?: AgentCapabilityPolicies,
): SystemPromptVars {
  const composioTriggers = process.env.COMPOSIO_PLATFORM_MODE === 'true';
  const webhookEndpoints = process.env.PLATFORM_AUTH_ACTIVE === 'true';
  const modelHints = modelPromptHints || [];
  const connectedAccounts = connectedAccountGroups();
  const remoteMcps = remoteMcpViews();
  const envVars = agentEnvVars(availableEnvVars);
  const userInstructions = userSystemPrompt?.trim() || '';
  return {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || PROMPT_ENV_DEFAULTS.CLAUDE_CONFIG_DIR,
    webSearchToolName: webSearchProvider ? 'mcp__web__web_search' : 'WebSearch',
    webFetchToolName: webFetchProvider ? 'mcp__web__web_fetch' : 'WebFetch',
    // Blocked subagents must not be advertised anywhere in the prompt; review
    // still advertises them (the gate happens at call time).
    subagentsEnabled: policyFor(capabilityPolicies, 'subagents') !== 'block',
    composioTriggers,
    webhookEndpoints,
    anyTriggers: composioTriggers || webhookEndpoints,
    computerUse: isComputerUseHost(),
    hasModelHints: modelHints.length > 0,
    modelHints,
    hasConnectedAccounts: connectedAccounts.length > 0,
    connectedAccounts,
    hasRemoteMcps: remoteMcps.length > 0,
    remoteMcps,
    hasEnvVars: envVars.length > 0,
    envVars,
    userInstructions,
  };
}

/**
 * Generates the full system prompt by rendering the SuperAgent prompt template
 * against the variable bag (env-gated triggers, web-search label, config dir)
 * plus dynamic sections (connected accounts, env vars, user instructions).
 */
export function generateSystemPrompt(
  availableEnvVars?: string[],
  userSystemPrompt?: string,
  modelPromptHints?: string[],
  webSearchProvider?: string,
  webFetchProvider?: string,
  capabilityPolicies?: AgentCapabilityPolicies,
): string {
  const vars = buildSystemPromptVars(availableEnvVars, userSystemPrompt, modelPromptHints, webSearchProvider, webFetchProvider, capabilityPolicies);
  return renderPrompt(SYSTEM_PROMPT, vars);
}

/**
 * Async message queue that bridges imperative sendMessage() calls
 * to an async iterable for the SDK's streaming input mode.
 */
export class MessageQueue {
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

  // Empty the buffer and return what was still waiting — the messages the SDK
  // never saw, which die when the queue is replaced on interrupt.
  drain(): SDKUserMessage[] {
    return this.queue.splice(0, this.queue.length);
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
  availableEnvVars?: string[];
  model?: string;
  browserModel?: string;
  dashboardBuilderModel?: string;
  webSearchProvider?: string;
  webFetchProvider?: string;
  maxOutputTokens?: number;
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  customEnvVars?: Record<string, string>;
  effort?: EffortLevel;
  speed?: SpeedLevel;
  capabilityPolicies?: AgentCapabilityPolicies;
  sessionCapabilityGrants?: Capability[];
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
  private webSearchProvider: string | undefined;
  private webFetchProvider: string | undefined;
  private maxOutputTokens: number | undefined;
  private maxThinkingTokens: number | undefined;
  private maxTurns: number | undefined;
  private maxBudgetUsd: number | undefined;
  private customEnvVars: Record<string, string> | undefined;
  private effort: EffortLevel | undefined;
  private speed: SpeedLevel | undefined;
  private capabilityPolicies: AgentCapabilityPolicies | undefined;
  // Session-scoped review grants ("Allow for this session"). Scoped to the
  // SESSION, not the process: they must survive idle-eviction + resume (the
  // session-manager persists them via the 'capability-grant' event), or the
  // host's grant record diverges and a gated launch hangs with no card.
  private sessionCapabilityGrants: Set<Capability>;
  // Kept so the system prompt can be regenerated when a capability block
  // boundary flips mid-session (the prompt gates delegation sections on it).
  private availableEnvVars: string[] | undefined;
  private userSystemPrompt: string | undefined;
  private modelPromptHints: string[] | undefined;
  private isReady: boolean = false;
  private isProcessing: boolean = false;
  // Monotonic id of the current query; bumped by initializeQuery. A previous
  // query's processMessages loop checks it before clearing shared flags in
  // its finally, so a slow teardown can't mark a fresh query stopped.
  private queryGeneration = 0;
  // Resolves when the current processMessages loop has fully unwound. stop()
  // awaits it so an evict-then-resume can't start a second query while the
  // first is still tearing down.
  private processingDone: Promise<void> | null = null;
  // Set by stop(), cleared by the sanctioned revival paths (start/restart).
  // An interrupt() overlapping a stop() must not restart the query it just
  // tore down: the revived subprocess would belong to a session the manager
  // believes is cold (or gone), invisible to the idle reaper.
  private stopping = false;
  // Completion of the most recent stop(). A sendMessage racing an in-flight
  // stop (its queue already closed but not yet nulled) must wait this out and
  // cold-restart — pushing into the closed queue would throw and silently
  // lose the message (e.g. an MCP-injection continuation).
  private currentStop: Promise<void> | null = null;
  // Terminal: the session was deleted. No path may revive this process.
  private disposed = false;
  private userMessageCount: number = 0;
  private isResumedSession: boolean;
  // Late-join replay state. A turn can complete before the host's WebSocket
  // attaches (createSession returns at `init`; an instant turn — e.g. a
  // UserPromptSubmit hook blocking the prompt — emits its result and idle in
  // the attach gap). Nothing buffers relayed frames, so a late subscriber
  // would never learn the turn ended and the host would show the session as
  // working forever. Track the most recent turn's terminal frames so the WS
  // handler can replay them to late joiners (see getLateJoinReplay).
  private currentTurnInformationals: SDKMessage[] = [];
  private lastTurnInformationals: SDKMessage[] = [];
  private lastResultMessage: SDKMessage | null = null;
  private lastSessionState: string | null = null;
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
    this.webSearchProvider = options.webSearchProvider;
    this.webFetchProvider = options.webFetchProvider;
    this.maxOutputTokens = options.maxOutputTokens;
    this.maxThinkingTokens = options.maxThinkingTokens;
    this.maxTurns = options.maxTurns;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.customEnvVars = options.customEnvVars;
    this.effort = options.effort;
    this.speed = options.speed;
    this.capabilityPolicies = options.capabilityPolicies;
    this.sessionCapabilityGrants = new Set(options.sessionCapabilityGrants ?? []);
    this.availableEnvVars = options.availableEnvVars;
    this.userSystemPrompt = options.userSystemPrompt;
    this.modelPromptHints = options.modelPromptHints;
    this.systemPrompt = generateSystemPrompt(
      options.availableEnvVars,
      options.userSystemPrompt,
      options.modelPromptHints,
      options.webSearchProvider,
      options.webFetchProvider,
      options.capabilityPolicies
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

    console.log(`[Session ${this.sessionId}] createQuery: model=${this.model ?? '(default)'}, effort=${this.effort ?? '(default)'}, speed=${this.speed ?? '(default)'}`);

    // Block-tier policies remove the capability at the source: the tool is
    // stripped from the query (and the system prompt stops advertising it)
    // rather than denied call-by-call. Review-tier gating happens in canUseTool.
    const capabilityTools = applyCapabilityPolicies(this.capabilityPolicies, {
      allowedTools: ['Skill', 'Task', 'Agent', ...remoteMcpToolPatterns],
      disallowedTools: [
        'TaskOutput', 'Monitor', 'DesignSync',
        'CronCreate', 'CronDelete', 'CronList',
        'ScheduleWakeup', 'RemoteTrigger', 'PushNotification',
        'EnterWorktree', 'ExitWorktree',
        // Suppress native WebSearch only when a host vendor is active; it's replaced by mcp__web__web_search.
        ...(this.webSearchProvider ? ['WebSearch'] : []),
        // Same for native WebFetch → mcp__web__web_fetch when a host fetch vendor is active.
        ...(this.webFetchProvider ? ['WebFetch'] : []),
      ],
    });

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
        settings: { enableWorkflows: capabilityTools.enableWorkflows },
        settingSources: ['user', 'project'],
        allowedTools: capabilityTools.allowedTools,
        disallowedTools: capabilityTools.disallowedTools,
        // Request summarized thinking so reasoning text streams to the UI. Without an
        // explicit `display`, Opus 4.8/4.7 default to `omitted` — thinking_delta events
        // arrive empty (only a signature), so the UI can show "Thinking" but no text.
        thinking: this.maxThinkingTokens
          ? { type: 'enabled', budgetTokens: this.maxThinkingTokens, display: 'summarized' }
          : { type: 'adaptive', display: 'summarized' },
        ...(this.maxTurns && { maxTurns: this.maxTurns }),
        ...(this.maxBudgetUsd && { maxBudgetUsd: this.maxBudgetUsd }),
        ...(this.effort && { effort: this.effort }),
        // withAgentAttributionHeaders folds the host-injected agent identity env
        // vars into ANTHROPIC_CUSTOM_HEADERS (composed here, after the custom-env
        // merge, so a user-set ANTHROPIC_CUSTOM_HEADERS is appended to, not lost).
        // withSpeedHeader then appends X-Superagent-Speed for non-normal tiers.
        env: withSpeedHeader(withAgentAttributionHeaders({
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
        }), this.speed),
        mcpServers: {
          'user-input': createUserInputMcpServer(),
          'browser': createBrowserMcpServer(browserMcpTools),
          'dashboards': createDashboardsMcpServer(),
          'agents': createAgentsMcpServer(() => this.sessionId),
          'chat': createChatMcpServer(() => this.sessionId),
          ...((this.webSearchProvider || this.webFetchProvider)
            ? { 'web': createWebMcpServer({ search: !!this.webSearchProvider, fetch: !!this.webFetchProvider }) }
            : {}),
          ...(isComputerUseHost() ? { 'computer-use': createComputerUseMcpServer() } : {}),
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
              // The subagent hard-codes its tools, so swap native WebSearch for the vendor tool
              // when one is active (native is Anthropic-server-side, absent on non-Claude models).
              ...(this.webSearchProvider ? ['mcp__web__web_search'] : ['WebSearch']),
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
          ...(isComputerUseHost() ? {
            'computer-use': {
              description: 'Desktop automation specialist for macOS and Windows. Delegate any task that requires interacting with native applications — clicking buttons, filling forms, reading screen content, navigating menus, or any multi-step app interaction. The app should already be launched and grabbed (use computer_launch first). This agent runs on a cheaper model and handles all app interactions autonomously.',
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
                questions,
                this.sessionId
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
            inputManager.setCurrentToolUseId(options.toolUseID, this.sessionId);
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
                    inputManager.setCurrentToolUseId(toolUseId, this.sessionId);
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
                    inputManager.setCurrentToolUseId(toolUseId, this.sessionId);
                  }
                  return {};
                },
              ],
            },
            {
              matcher: 'Bash',
              hooks: [
                async (input) => {
                  const toolInput = (input as any).tool_input as Record<string, unknown> | undefined;
                  if (!startsWithAgentBrowserCommand(toolInput?.command)) return {};
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      additionalContext: AGENT_BROWSER_BASH_WARNING,
                    },
                  };
                },
              ],
            },
            {
              // Launch-policy gate for subagents/workflows — see
              // createCapabilityGateHook for why this is a hook and not
              // canUseTool.
              matcher: '^(Task|Agent|Workflow)$',
              timeout: CAPABILITY_REVIEW_HOOK_TIMEOUT_S,
              hooks: [
                createCapabilityGateHook({
                  sessionId: this.sessionId,
                  getPolicies: () => this.capabilityPolicies,
                  getSessionGrants: () => this.sessionCapabilityGrants,
                  onSessionGrant: (capability) => {
                    this.sessionCapabilityGrants.add(capability);
                    // Session-manager persists it so the grant survives eviction+resume.
                    this.emit('capability-grant', { capability });
                  },
                  onReviewCancelled: (cancelledToolUseId, capability) => {
                    // Same relay as SDK frames (persister → SSE → renderer),
                    // so the host closes the orphaned approval card.
                    this.emit('message', {
                      type: 'capability_review_cancelled',
                      toolUseId: cancelledToolUseId,
                      capability,
                      session_id: this.claudeSessionId || this.sessionId,
                    });
                  },
                }),
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
    // New query generation: a stale processMessages loop from a previous
    // query must not clobber this one's state when it finally unwinds.
    this.queryGeneration++;
    this.abortController = new AbortController();
    this.messageQueue = new MessageQueue();
    this.queryInstance = this.createQuery();
    this.isReady = true;
    // Background tasks are process-local and die with the old process; the
    // SessionManager listens for this to reset its settlement bookkeeping —
    // a task id carried across the replacement would pin the session
    // unevictable forever (no terminal signal or snapshot ever comes).
    this.emit('query-start');
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error(`Session ${this.sessionId} process was disposed`);
    }
    this.stopping = false;
    const isResuming = !!this.claudeSessionId;
    console.log(`[Session ${this.sessionId}] Starting SDK-based session`);
    console.log(`[Session ${this.sessionId}] ANTHROPIC_API_KEY set:`, !!process.env.ANTHROPIC_API_KEY);
    console.log(`[Session ${this.sessionId}] Working directory:`, this.workingDirectory);
    console.log(`[Session ${this.sessionId}] Resuming:`, isResuming, this.claudeSessionId);

    this.initializeQuery();
    this.emit('ready');

    // Start processing messages in the background
    this.processingDone = this.processMessages();
  }

  private async processMessages(): Promise<void> {
    if (!this.queryInstance) return;

    const generation = this.queryGeneration;
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
          if (lastResultWasError && resultNeedsResumeErrorFallback(msg) && this.claudeSessionId) {
            msg.error = 'This session could not be resumed (it may have been corrupted by a previous crash). Please start a new session.';
          }
          console.log(`[Session ${this.sessionId}] Query completed`);
        }

        this.trackForLateJoinReplay(message);
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
      // A newer query may already be live (initializeQuery bumped the
      // generation while this loop was still unwinding) — its flags are not
      // ours to clear.
      if (generation === this.queryGeneration) {
        this.isProcessing = false;
        this.isReady = false;
      }
      this.emit('exit', 0);
    }
  }

  async sendMessage(content: string, uuid?: UUID, options?: { effort?: EffortLevel; speed?: SpeedLevel; model?: string; shouldQuery?: boolean; capabilityPolicies?: AgentCapabilityPolicies }): Promise<void> {
    const effort = options?.effort;
    const speed = options?.speed;
    const model = options?.model;

    // Treat undefined stored effort as 'high' so pre-existing sessions (created before
    // this feature) don't trigger a spurious restart on their first post-upgrade message.
    const currentEffort: EffortLevel = this.effort ?? 'high';
    const effortChanged = effort !== undefined && effort !== currentEffort;

    // Same undefined-vs-default trick: an unset speed IS 'normal' on the wire
    // (no header), so an explicit 'normal' on a pre-speed session is a no-op.
    const currentSpeed: SpeedLevel = this.speed ?? 'normal';
    const speedChanged = speed !== undefined && speed !== currentSpeed;

    // The host resolves selections to concrete wire ids before sending, so
    // compare ids directly. Switching between two pinned versions of a family
    // (e.g. opus-4-6 -> opus-4-7) is now a real, intentional switch.
    const modelChanged = model !== undefined && model !== this.model;

    // Capability policies follow the host's CURRENT settings, refreshed on
    // every message so a long-lived session tracks settings changes. Review
    // and the block backstop read the field at call time; only a block
    // boundary flip needs a re-query (tool lists + prompt are baked in).
    const nextPolicies = options?.capabilityPolicies;
    const capabilityBlockChanged = nextPolicies !== undefined && blockBoundaryChanged(this.capabilityPolicies, nextPolicies);
    if (nextPolicies !== undefined) {
      this.capabilityPolicies = nextPolicies;
      if (capabilityBlockChanged) {
        this.systemPrompt = generateSystemPrompt(
          this.availableEnvVars,
          this.userSystemPrompt,
          this.modelPromptHints,
          this.webSearchProvider,
          this.webFetchProvider,
          nextPolicies
        );
      }
      this.reconcilePendingCapabilityReviews();
    }

    if (effortChanged) {
      this.effort = effort;
    }
    if (speedChanged) {
      this.speed = speed;
    }
    if (modelChanged) {
      this.model = model;
    }

    if (this.stopping || !this.messageQueue || !this.isReady) {
      // Cold session, or a stop in flight (queue closed but not yet nulled —
      // pushing would throw and lose the message): wait the stop out, then
      // restart. First init picks up the (possibly new) effort/model values.
      console.log(`[Session ${this.sessionId}] Session not running, restarting...`);
      if (this.currentStop) {
        await this.currentStop.catch(() => undefined);
      }
      await this.restart();
    } else if (effortChanged || speedChanged || capabilityBlockChanged) {
      // Effort can only be set at query creation time — the SDK has no setEffort
      // facility — so any effort change forces an interrupt + re-query. Speed
      // lives in the query env (ANTHROPIC_CUSTOM_HEADERS), which is likewise
      // baked at query creation. The new model (if also changed) is picked up by
      // the same restart. A capability block boundary flip re-queries for the
      // same reason: the tool lists and system prompt only apply at query creation.
      const reasons: string[] = [];
      if (effortChanged) reasons.push(`effort ${currentEffort} -> ${effort}`);
      if (speedChanged) reasons.push(`speed ${currentSpeed} -> ${speed}`);
      if (capabilityBlockChanged) reasons.push('capability block boundary changed');
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
    // Every send path must reach the session's settlement tracker — including
    // internal ones that bypass SessionManager.sendMessage (the MCP-injection
    // continuation in addRemoteMcpServer). Without this, a send landing while
    // the tracker reads settled leaves the reaper free to kill the turn it
    // just started.
    this.emit('outbound-message', { expectsResponse: shouldQuery !== false });
  }

  /**
   * Settles pending capability reviews that a policy change made moot: a
   * capability now on 'allow' auto-approves them (one-time), one now on
   * 'block' rejects them. Without this, loosening the policy would strand
   * the paused launch — the host stops rendering a card the container is
   * still waiting on.
   */
  private reconcilePendingCapabilityReviews(): void {
    for (const pending of inputManager.getAllPending()) {
      if (pending.inputType !== 'capability_review' || pending.sessionId !== this.sessionId) continue;
      const capability = (pending.metadata as { capability?: Capability } | undefined)?.capability;
      if (capability !== 'subagents' && capability !== 'workflows') continue;
      const policy = policyFor(this.capabilityPolicies, capability);
      if (policy === 'allow') {
        console.log(`[Session ${this.sessionId}] Auto-approving pending ${capability} review ${pending.toolUseId} (policy now allow)`);
        inputManager.resolve(pending.toolUseId, { scope: 'once' });
      } else if (policy === 'block') {
        console.log(`[Session ${this.sessionId}] Rejecting pending ${capability} review ${pending.toolUseId} (policy now block)`);
        inputManager.reject(pending.toolUseId, blockedCapabilityMessage(capability));
      }
    }
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
    if (this.disposed) {
      throw new Error(`Session ${this.sessionId} process was disposed`);
    }
    console.log(`[Session ${this.sessionId}] Restarting session`);
    this.stopping = false;
    this.initializeQuery();
    this.processingDone = this.processMessages();
  }

  /**
   * Terminal stop for deleteSession/shutdown: after this, no straggler
   * (a deferred MCP-injection interrupt/continuation, a late caller holding
   * the object) can revive the subprocess — the session it belonged to no
   * longer exists anywhere the reaper can see.
   */
  async dispose(options?: { graceful?: boolean; graceMs?: number }): Promise<void> {
    this.disposed = true;
    await this.stop(options);
  }

  /**
   * graceful: close the input stream and give the CLI a bounded window to
   * exit on stdin EOF BEFORE aborting. An immediate abort hard-kills the CLI,
   * racing its transcript flush — a reaper sweep landing right after idle (or
   * during the boot of a shouldQuery:false append restart) then truncates the
   * tail of the session JSONL, and the next --resume silently loses those
   * turns. Proven live: identical evict-after-turn runs lost walnut-9/turn-2
   * context on one run and kept it on the next. Eviction and shutdown must
   * quiesce; deleteSession may keep the hard kill (the transcript is doomed
   * anyway).
   */
  async stop(options?: { graceful?: boolean; graceMs?: number }): Promise<void> {
    const stopRun = this.performStop(options);
    this.currentStop = stopRun;
    await stopRun;
  }

  private async performStop(options?: { graceful?: boolean; graceMs?: number }): Promise<void> {
    console.log(`[Session ${this.sessionId}] Stopping session${options?.graceful ? ' (graceful)' : ''}`);
    this.stopping = true;

    // Close the message queue to signal end of input
    if (this.messageQueue) {
      this.messageQueue.close();
    }

    if (options?.graceful && this.processingDone) {
      // Stdin EOF lets the CLI finish pending work (transcript writes, an
      // in-flight append) and exit cleanly, ending the message stream. Bounded:
      // a CLI that ignores EOF gets the abort below, same as a hard stop.
      // (Live-measured: a settled CLI exits ~1s after EOF.)
      await Promise.race([
        this.processingDone.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, options.graceMs ?? 8000)),
      ]);
    }

    // Abort the query if still running
    if (this.abortController) {
      this.abortController.abort();
    }

    // Wait for the processing loop to fully unwind — a fixed sleep is not
    // enough: if SDK teardown outlives it, a restart (evict-then-resume) can
    // start a second query while this one is still alive, whose finally then
    // marks the new query stopped and the next message spawns a third,
    // leaking the second's subprocess. Bounded so a hung teardown cannot
    // wedge stop() forever; the generation guard covers the timeout path.
    if (this.processingDone) {
      await Promise.race([
        this.processingDone.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    this.isReady = false;
    this.queryInstance = null;
    this.messageQueue = null;
    this.abortController = null;
  }

  isRunning(): boolean {
    return this.isReady && this.isProcessing;
  }

  /** Record the frames a late-joining WebSocket subscriber must not miss. */
  private trackForLateJoinReplay(message: SDKMessage): void {
    const msg = message as { type: string; subtype?: string; state?: string };
    if (msg.type === 'system' && msg.subtype === 'informational') {
      this.currentTurnInformationals.push(message);
    } else if (msg.type === 'result') {
      this.lastResultMessage = message;
      this.lastTurnInformationals = this.currentTurnInformationals;
      this.currentTurnInformationals = [];
    } else if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      this.lastSessionState = msg.state ?? null;
    }
  }

  /**
   * Terminal frames of the most recent turn, for WebSocket subscribers that
   * attached after the turn already ended. createSession returns at `init`,
   * so an instant turn (e.g. a UserPromptSubmit hook blocking the prompt)
   * finishes — result and idle included — before the host's socket exists;
   * without a replay the host never learns the turn ended and shows the
   * session as working forever.
   *
   * Only replays when the session is currently idle (a running turn will
   * deliver its own frames live), and marks every frame `replayed: true` so
   * the host can ignore the catch-up when it already saw the live copies.
   */
  getLateJoinReplay(): unknown[] {
    if (this.lastSessionState !== 'idle' || !this.lastResultMessage) {
      return [];
    }
    return [
      ...this.lastTurnInformationals,
      this.lastResultMessage,
      {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: this.claudeSessionId || this.sessionId,
      },
    ].map((m) => ({ ...(m as Record<string, unknown>), replayed: true }));
  }

  async interrupt(): Promise<InterruptOutcome> {
    console.log(`[Session ${this.sessionId}] Interrupting current query`);

    if (this.stopping || !this.abortController || !this.isProcessing) {
      console.log(`[Session ${this.sessionId}] Nothing to interrupt`);
      return { interrupted: false, discardedUuids: [] };
    }

    // Ask the SDK which async messages are still queued BEFORE killing the
    // query — after the abort the stream just stops and that knowledge is
    // gone (queued command_lifecycle frames never resolve; see the
    // sdk206-queued-message-interrupt fixture). The receipt's still_queued
    // messages would survive a graceful interrupt and run — our Stop
    // semantics kill them, so cancel each one while the query is still alive
    // and report it as discarded.
    const discardedUuids: string[] = [];
    if (this.queryInstance) {
      try {
        const receipt = await Promise.race([
          this.queryInstance.interrupt(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
        ]);
        for (const uuid of stillQueuedFromReceipt(receipt)) {
          // Reuses the two-layer cancel; false = already dequeued for
          // execution, in which case the abort below kills it mid-turn and
          // its user message has already materialized — not "discarded".
          const cancelled = await this.cancelQueuedMessage(uuid as UUID);
          if (cancelled) discardedUuids.push(uuid);
        }
      } catch (error) {
        // Old CLI without the interrupt control request, or a query already
        // torn down — the abort below still stops the turn; we just cannot
        // name the SDK-side queued casualties.
        console.warn(`[Session ${this.sessionId}] Graceful interrupt failed, falling back to abort:`, error);
      }
    }

    // Messages still buffered locally (never handed to the SDK) die when the
    // queue is replaced below.
    for (const message of this.messageQueue?.drain() ?? []) {
      if (message.uuid) discardedUuids.push(message.uuid);
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

    // The SDK's own terminal lifecycle frames died with the query, so emit
    // them ourselves: downstream (persister → SSE → renderer) learns each
    // dead uuid through the exact same pipeline as real SDK frames and can
    // rescue the message text deterministically instead of racing a refetch.
    for (const uuid of discardedUuids) {
      this.emit('message', {
        type: 'command_lifecycle',
        command_uuid: uuid,
        state: 'discarded',
        session_id: this.claudeSessionId || this.sessionId,
      });
    }

    // A stop()/dispose() may have raced in while we were waiting above — the
    // teardown wins: restarting here would revive a subprocess for a session
    // the manager already considers cold (or deleted), leaking it past the
    // reaper. The abort already landed, so the turn is dead either way.
    if (this.stopping) {
      console.log(`[Session ${this.sessionId}] Stop raced the interrupt — not restarting query`);
      return { interrupted: true, discardedUuids };
    }

    // Restart the query with resume to continue the session
    console.log(`[Session ${this.sessionId}] Restarting query after interrupt`);
    this.initializeQuery();
    this.processingDone = this.processMessages();

    return { interrupted: true, discardedUuids };
  }
}
