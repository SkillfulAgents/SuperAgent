import { v4 as uuidv4 } from 'uuid';
import type { UUID } from 'crypto';
import { Session, SDKMessage, CreateSessionRequest, EffortLevel, AgentCapabilityPolicies } from './types';
import { agentCapabilityPoliciesSchema } from './capability-policies';
import { ClaudeCodeProcess } from './claude-code';
import { SessionPersistence } from './session-persistence';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { releaseBrowserLock } from './browser-state';
import { claudeSettingsSchema, SESSION_RETENTION_DAYS } from './claude-settings-schema';
import { SessionSettlementTracker } from './session-settlement';

interface SessionData {
  session: Session;
  process: ClaudeCodeProcess;
  subscribers: Set<(message: SDKMessage) => void>;
  // Whether the session is settled (turn over, no background work, not in a
  // completion-wake window) — the only state a subprocess may be stopped in.
  settlement: SessionSettlementTracker;
  eviction: Promise<void> | null;
}

const DEFAULT_INTERACTIVE_IDLE_EVICTION_MINUTES = 5;
const DEFAULT_AUTOMATED_IDLE_EVICTION_MINUTES = 0;
const IDLE_EVICTION_POLL_MS = 30_000;

// Minutes → ms. < 0 disables that class; 0 = evict as soon as idle.
// Parsed once at startup so misconfiguration is loud.
function idleEvictionMsFromEnv(
  envName: string,
  defaultMinutes: number
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') {
    return defaultMinutes * 60_000;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) {
    console.error(
      `Invalid ${envName} "${raw}" — using default ${defaultMinutes}`
    );
    return defaultMinutes * 60_000;
  }
  return minutes * 60_000;
}

function formatIdleThreshold(ms: number): string {
  if (ms < 0) return 'disabled';
  if (ms === 0) return 'immediate';
  return `${Math.round(ms / 60_000)}m`;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionData> = new Map();
  // In-flight resumes, keyed by session id — see resumeSession().
  private resuming: Map<string, Promise<SessionData | undefined>> = new Map();
  private baseWorkingDirectory: string;
  private persistence: SessionPersistence;
  private readonly idleEvictionMs: number;
  private readonly automatedIdleEvictionMs: number;
  private readonly wakeGraceMs: number | undefined;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    baseWorkingDirectory: string = '/workspace',
    options?: {
      idleEvictionMs?: number;
      automatedIdleEvictionMs?: number;
      wakeGraceMs?: number;
      evictionPollMs?: number;
    }
  ) {
    super();
    this.baseWorkingDirectory = baseWorkingDirectory;
    this.persistence = new SessionPersistence();
    this.wakeGraceMs = options?.wakeGraceMs;
    this.idleEvictionMs =
      options?.idleEvictionMs ??
      idleEvictionMsFromEnv(
        'SESSION_IDLE_EVICTION_MINUTES',
        DEFAULT_INTERACTIVE_IDLE_EVICTION_MINUTES
      );
    this.automatedIdleEvictionMs =
      options?.automatedIdleEvictionMs ??
      idleEvictionMsFromEnv(
        'SESSION_AUTOMATED_IDLE_EVICTION_MINUTES',
        DEFAULT_AUTOMATED_IDLE_EVICTION_MINUTES
      );
    if (this.idleEvictionMs >= 0 || this.automatedIdleEvictionMs >= 0) {
      console.log(
        `[SessionManager] Idle session eviction enabled: interactive=${formatIdleThreshold(this.idleEvictionMs)}, automated=${formatIdleThreshold(this.automatedIdleEvictionMs)}`
      );
      this.evictionTimer = setInterval(() => {
        this.evictIdleSessions().catch((error) => {
          console.error('[SessionManager] Idle eviction sweep failed:', error);
        });
      }, options?.evictionPollMs ?? IDLE_EVICTION_POLL_MS);
      // Never keep the process alive just for the reaper.
      this.evictionTimer.unref?.();
    }

    // Ensure base directory exists
    if (!fs.existsSync(this.baseWorkingDirectory)) {
      fs.mkdirSync(this.baseWorkingDirectory, { recursive: true });
    }

    // Ensure .claude/skills directory exists for Skills support
    const skillsDir = `${this.baseWorkingDirectory}/.claude/skills`;
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    this.ensureClaudeSettings();
  }

  /**
   * Ensure `$CLAUDE_CONFIG_DIR/settings.json` pins the session-transcript
   * retention period. The CLI reads its user settings.json from
   * CLAUDE_CONFIG_DIR (`/workspace/.claude`), NOT from `~/.claude`, so the
   * image-baked settings.json under /home/claude/.claude is never consulted.
   * Without this, the CLI's default ~30-day cleanup deletes old session JSONL
   * files on startup — they then linger in session-metadata.json (so they show
   * in the nav) but fail to load because the transcript is gone.
   *
   * Merges into any existing settings.json rather than clobbering it, so other
   * settings written by the CLI or a skill are preserved.
   */
  private ensureClaudeSettings(): void {
    const settingsPath = `${this.baseWorkingDirectory}/.claude/settings.json`;
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        existing = claudeSettingsSchema.parse(
          JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        );
      }

      if (existing.cleanupPeriodDays === SESSION_RETENTION_DAYS) {
        return; // Already correct — avoid a needless write on every startup.
      }

      const merged = claudeSettingsSchema.parse({
        ...existing,
        cleanupPeriodDays: SESSION_RETENTION_DAYS,
      });
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    } catch (error) {
      // Never let a settings-provisioning failure block the server from
      // starting; worst case the CLI falls back to its default retention.
      console.error('Failed to ensure Claude settings.json:', error);
    }
  }

  /**
   * Creates a new session with an initial message.
   * This is an atomic operation that:
   * 1. Starts the Claude process
   * 2. Sends the first message
   * 3. Waits for Claude's session ID (emitted after first message)
   * 4. Returns the session with Claude's canonical ID
   *
   * This ensures the session ID matches Claude's JSONL file name.
   */
  async createSession(request: CreateSessionRequest): Promise<Session> {
    if (!request.initialMessage) {
      throw new Error('initialMessage is required for createSession');
    }

    const tempSessionId = uuidv4();
    // All sessions share the same working directory
    const workingDirectory = request.workingDirectory || this.baseWorkingDirectory;

    // Boundary validation: a malformed policy must fail the request loudly,
    // never silently degrade a block to allow.
    const capabilityPolicies = agentCapabilityPoliciesSchema.parse(request.capabilityPolicies);

    // Ensure working directory exists
    if (!fs.existsSync(workingDirectory)) {
      fs.mkdirSync(workingDirectory, { recursive: true });
    }

    const process = new ClaudeCodeProcess({
      sessionId: tempSessionId,
      workingDirectory,
      userSystemPrompt: request.systemPrompt,
      modelPromptHints: request.modelPromptHints,
      availableEnvVars: request.availableEnvVars,
      model: request.model,
      browserModel: request.browserModel,
      dashboardBuilderModel: request.dashboardBuilderModel,
      webSearchProvider: request.webSearchProvider,
      webFetchProvider: request.webFetchProvider,
      maxOutputTokens: request.maxOutputTokens,
      maxThinkingTokens: request.maxThinkingTokens,
      maxTurns: request.maxTurns,
      maxBudgetUsd: request.maxBudgetUsd,
      customEnvVars: request.customEnvVars,
      effort: request.effort,
      capabilityPolicies,
    });

    // Promise to capture Claude's session ID and slash commands (emitted after first message is sent)
    const initCompletePromise = new Promise<string>((resolve, reject) => {
      let claudeSessionId: string | null = null;
      const timeout = setTimeout(() => {
        if (claudeSessionId) resolve(claudeSessionId);
        else reject(new Error('Timeout waiting for Claude session ID'));
      }, 30000);

      process.once('claude-session-id', (id: string) => {
        claudeSessionId = id;
      });

      process.once('init-complete', () => {
        clearTimeout(timeout);
        if (claudeSessionId) resolve(claudeSessionId);
        else reject(new Error('init-complete fired before session ID was captured'));
      });

      process.once('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Start the process and wait for the init handshake. On ANY failure the
    // started process must be torn down here: it has no session entry yet, so
    // nothing else — not the reaper, not a delete — could ever reach it.
    let claudeSessionId: string;
    try {
      await process.start();

      // Send the initial message - this triggers Claude to emit the session ID
      await process.sendMessage(request.initialMessage, request.initialMessageUuid);

      // Wait for init to complete (session ID + slash commands)
      claudeSessionId = await initCompletePromise;
    } catch (error) {
      await process.dispose().catch(() => undefined);
      throw error;
    }
    console.log(`Got Claude session ID: ${claudeSessionId}`);

    // Use Claude's session ID as the canonical session ID
    const sessionId = claudeSessionId;

    const session: Session = {
      id: sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
      metadata: request.metadata,
      workingDirectory,
      envVars: request.envVars,
      systemPrompt: request.systemPrompt,
      modelPromptHints: request.modelPromptHints,
      availableEnvVars: request.availableEnvVars,
      slashCommands: process.slashCommands,
    };

    const sessionData: SessionData = {
      session,
      process,
      subscribers: new Set(),
      // Authority: this container always runs the CLI with
      // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1, so idle comes from state
      // events only — a bare result (pre-init running event is dropped by
      // listener-attach timing; queued streams carry intermediate results)
      // must never read as settled.
      settlement: new SessionSettlementTracker({
        wakeGraceMs: this.wakeGraceMs,
        stateEventsAuthority: true,
      }),
      eviction: null,
    };

    // Set up event listeners
    process.on('message', (message: SDKMessage) => {
      this.handleMessage(sessionId, message);
    });

    // Covers send paths that bypass this.sendMessage (e.g. the MCP-injection
    // continuation), so the tracker can never read settled mid-turn.
    process.on('outbound-message', (info: { expectsResponse: boolean }) => {
      sessionData.settlement.noteOutboundMessage(info);
    });

    // Background tasks die with the CLI process, and a fresh process emits no
    // initial snapshot — carried-over ids would pin the session forever.
    process.on('query-start', () => {
      sessionData.settlement.resetBackgroundTasks();
    });

    process.on('stderr', (error: string) => {
      console.error(`[Session ${sessionId}] stderr:`, error);
    });

    process.on('exit', (code: number | null) => {
      console.log(`Session ${sessionId} exited with code ${code}`);
    });

    // Session-scoped review grants must survive eviction+resume.
    process.on('capability-grant', ({ capability }: { capability: 'subagents' | 'workflows' }) => {
      this.persistence.addSessionCapabilityGrant(sessionId, capability);
    });

    // Persist the session
    this.persistence.saveSession({
      sessionId,
      claudeSessionId,
      workingDirectory,
      createdAt: session.createdAt.toISOString(),
      lastActivity: session.lastActivity.toISOString(),
      systemPrompt: request.systemPrompt,
      modelPromptHints: request.modelPromptHints,
      availableEnvVars: request.availableEnvVars,
      model: request.model,
      browserModel: request.browserModel,
      dashboardBuilderModel: request.dashboardBuilderModel,
      webSearchProvider: request.webSearchProvider,
      webFetchProvider: request.webFetchProvider,
      maxOutputTokens: request.maxOutputTokens,
      maxThinkingTokens: request.maxThinkingTokens,
      maxTurns: request.maxTurns,
      maxBudgetUsd: request.maxBudgetUsd,
      customEnvVars: request.customEnvVars,
      effort: request.effort,
      capabilityPolicies,
      metadata: request.metadata,
    });

    this.sessions.set(sessionId, sessionData);

    console.log(`Created session ${sessionId} with working directory ${workingDirectory}`);
    return session;
  }

  /**
   * Dedup wrapper: concurrent callers of a cold session (a POST racing a GET,
   * two rapid sends after a container restart) share ONE in-flight resume and
   * only see the session once it has fully started. Publishing a
   * half-initialized entry instead (the previous approach) let a second
   * sender deliver its message before the first caller's — reversing
   * conversation order at the model.
   */
  private resumeSession(sessionId: string): Promise<SessionData | undefined> {
    const inFlight = this.resuming.get(sessionId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.doResumeSession(sessionId).finally(() => {
      this.resuming.delete(sessionId);
    });
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async doResumeSession(sessionId: string): Promise<SessionData | undefined> {
    // Check if we have persisted data for this session
    const persisted = this.persistence.getSession(sessionId);
    if (!persisted) {
      return undefined;
    }

    console.log(`Attempting to resume session ${sessionId} with Claude session ID ${persisted.claudeSessionId}`);

    try {
      // Create a new Claude Code process with resume
      const process = new ClaudeCodeProcess({
        sessionId,
        workingDirectory: persisted.workingDirectory,
        claudeSessionId: persisted.claudeSessionId,
        userSystemPrompt: persisted.systemPrompt,
        modelPromptHints: persisted.modelPromptHints,
        availableEnvVars: persisted.availableEnvVars,
        model: persisted.model,
        browserModel: persisted.browserModel,
        dashboardBuilderModel: persisted.dashboardBuilderModel,
        webSearchProvider: persisted.webSearchProvider,
        webFetchProvider: persisted.webFetchProvider,
        maxOutputTokens: persisted.maxOutputTokens,
        maxThinkingTokens: persisted.maxThinkingTokens,
        maxTurns: persisted.maxTurns,
        maxBudgetUsd: persisted.maxBudgetUsd,
        customEnvVars: persisted.customEnvVars,
        effort: persisted.effort,
        capabilityPolicies: persisted.capabilityPolicies,
        sessionCapabilityGrants: persisted.sessionCapabilityGrants,
      });

      const session: Session = {
        id: sessionId,
        createdAt: new Date(persisted.createdAt),
        lastActivity: new Date(),
        // Restore metadata so a resumed automated session keeps its eviction
        // class (and its release-browser-lock-on-result behavior).
        metadata: persisted.metadata,
        workingDirectory: persisted.workingDirectory,
        systemPrompt: persisted.systemPrompt,
        modelPromptHints: persisted.modelPromptHints,
        availableEnvVars: persisted.availableEnvVars,
      };

      const data: SessionData = {
        session,
        process,
        subscribers: new Set(),
        // Born-idle: a bare getSession() resume gets no turn (no result, never
        // idle), so born-busy would park the process beyond the reaper forever.
        // sendMessage marks the tracker busy itself right after resuming.
        settlement: new SessionSettlementTracker({
          bornIdle: true,
          wakeGraceMs: this.wakeGraceMs,
          stateEventsAuthority: true,
        }),
        eviction: null,
      };

      // Set up event listeners (same as createSession)
      process.on('message', (message: SDKMessage) => {
        this.handleMessage(sessionId, message);
      });

      process.on('outbound-message', (info: { expectsResponse: boolean }) => {
        data.settlement.noteOutboundMessage(info);
      });

      process.on('query-start', () => {
        data.settlement.resetBackgroundTasks();
      });

      process.on('stderr', (error: string) => {
        console.error(`[Session ${sessionId}] stderr:`, error);
      });

      process.on('exit', (code: number | null) => {
        console.log(`Resumed session ${sessionId} exited with code ${code}`);
      });

      process.on('capability-grant', ({ capability }: { capability: 'subagents' | 'workflows' }) => {
        this.persistence.addSessionCapabilityGrant(sessionId, capability);
      });

      // Start the process (which will resume the Claude session)
      // Note: slash commands are captured later when init event fires via WebSocket
      await process.start();

      // Publish only once fully started — concurrent callers wait on the
      // resuming promise, never on a half-initialized entry. A failed start
      // therefore also can't leave a zombie in the map.
      this.sessions.set(sessionId, data);

      console.log(`Successfully resumed session ${sessionId}`);
      return data;
    } catch (error) {
      console.error(`Failed to resume session ${sessionId}:`, error);
      return undefined;
    }
  }

  /**
   * Whether the session is live in memory right now. Unlike getSession(),
   * never resumes from persistence — used for browser-lock liveness checks
   * where resurrecting a session would defeat the purpose.
   */
  hasActiveSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    let sessionData = this.sessions.get(sessionId);

    // Try to resume if not in memory
    if (!sessionData) {
      sessionData = await this.resumeSession(sessionId);
      if (!sessionData) return null;
    }

    // Update last activity
    sessionData.session.lastActivity = new Date();
    this.persistence.updateLastActivity(sessionId);
    return sessionData.session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;

    // Release browser lock if this session owns it
    const released = releaseBrowserLock(sessionId);
    if (released) {
      console.log(`[Session ${sessionId}] Released browser lock (session deleted)`);
    }

    // Stop the process terminally — dispose (not stop) so a straggler
    // interrupt/continuation can't revive a subprocess for a session that no
    // longer exists in this map (the reaper would never see it).
    await sessionData.process.dispose();

    // Clean up subscribers
    sessionData.subscribers.clear();

    // Remove from map
    this.sessions.delete(sessionId);

    // Remove from persistence
    this.persistence.deleteSession(sessionId);

    console.log(`Deleted session ${sessionId}`);
    return true;
  }

  async sendMessage(
    sessionId: string,
    content: string,
    uuid?: UUID,
    options?: { effort?: EffortLevel; model?: string; shouldQuery?: boolean; capabilityPolicies?: AgentCapabilityPolicies }
  ): Promise<void> {
    let sessionData = this.sessions.get(sessionId);

    // Try to resume if not in memory
    if (!sessionData) {
      sessionData = await this.resumeSession(sessionId);
      if (!sessionData) {
        throw new Error(`Session ${sessionId} not found`);
      }
    }

    // A racing idle eviction may be closing the message queue right now; wait it
    // out, then process.sendMessage's cold-session path restarts with --resume.
    if (sessionData.eviction) {
      await sessionData.eviction;
    }
    // A shouldQuery:false append runs no turn — it must not mark the session
    // busy, or it becomes unevictable until the next real turn.
    const expectsResponse = options?.shouldQuery !== false;
    sessionData.settlement.noteOutboundMessage({ expectsResponse });

    // A real message into an automated session is human-originated (the
    // scheduler and trigger-manager only ever CREATE sessions; cross-agent
    // chat appends are shouldQuery:false) — promote it to the interactive
    // eviction class so the conversation doesn't pay a cold restart after
    // every turn.
    if (expectsResponse && sessionData.session.metadata?.isAutomated) {
      console.log(`[Session ${sessionId}] Promoting automated session to interactive (human message)`);
      sessionData.session.metadata = { ...sessionData.session.metadata, isAutomated: false };
      this.persistence.updateMetadata(sessionId, sessionData.session.metadata);
    }

    // Update last activity
    sessionData.session.lastActivity = new Date();
    this.persistence.updateLastActivity(sessionId);

    // Persist runtime-options changes so resume after eviction uses the latest values
    if (options?.effort !== undefined) {
      this.persistence.updateEffort(sessionId, options.effort);
    }
    if (options?.model !== undefined) {
      this.persistence.updateModel(sessionId, options.model);
    }
    if (options?.capabilityPolicies !== undefined) {
      this.persistence.updateCapabilityPolicies(sessionId, options.capabilityPolicies);
    }

    // Send to Claude Code process (messages are stored via handleMessage)
    await sessionData.process.sendMessage(content, uuid, options);
  }

  /**
   * Cancel a queued (not yet picked up) message. Returns false when the
   * session isn't live or the message was already dequeued for execution —
   * a session that needs resuming has no queue, so nothing to cancel.
   */
  async cancelQueuedMessage(sessionId: string, uuid: UUID): Promise<boolean> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    return sessionData.process.cancelQueuedMessage(uuid);
  }

  subscribe(sessionId: string, callback: (message: SDKMessage) => void): () => void {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionData.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      sessionData.subscribers.delete(callback);
    };
  }

  // Broadcast an arbitrary message to all subscribers of a session
  broadcast(sessionId: string, message: unknown): void {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;

    sessionData.subscribers.forEach((callback) => {
      try {
        callback(message as SDKMessage);
      } catch (error) {
        console.error(`Error in subscriber callback:`, error);
      }
    });
  }

  private handleMessage(sessionId: string, message: SDKMessage): void {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;

    sessionData.settlement.handleMessage(message);

    // Release browser lock when an automated session's turn completes.
    // The SDK query keeps the for-await loop alive waiting for the next user
    // message, so the 'exit' event never fires for idle sessions. Releasing
    // on 'result' ensures the lock is freed as soon as the model finishes.
    if (message.type === 'result' && sessionData.session.metadata?.isAutomated) {
      const released = releaseBrowserLock(sessionId);
      if (released) {
        console.log(`[Session ${sessionId}] Released browser lock (automated session turn completed)`);
      }
    }

    // Notify all subscribers
    sessionData.subscribers.forEach((callback) => {
      try {
        callback(message);
      } catch (error) {
        console.error(`Error in subscriber callback:`, error);
      }
    });

    // Update last activity
    sessionData.session.lastActivity = new Date();
  }

  private idleThresholdMs(data: SessionData): number {
    return data.session.metadata?.isAutomated
      ? this.automatedIdleEvictionMs
      : this.idleEvictionMs;
  }

  // Stop the claude subprocess of sessions idle past their class threshold.
  // Interactive default 5m; automated (cron/webhook) default 0 = next sweep.
  // Eviction only stops the process — SessionData + claudeSessionId survive so
  // the next sendMessage restarts with --resume. Public for tests.
  async evictIdleSessions(): Promise<void> {
    const now = Date.now();
    const evictions: Promise<void>[] = [];
    for (const [sessionId, data] of this.sessions) {
      if (data.eviction) continue; // already evicting
      if (!data.settlement.isSettled(now)) continue;
      if (!data.process.isRunning()) continue; // already cold
      const thresholdMs = this.idleThresholdMs(data);
      if (thresholdMs < 0) continue; // disabled for this class
      if (now - data.session.lastActivity.getTime() < thresholdMs) continue;

      data.eviction = (async () => {
        try {
          // An idle session has no business holding the shared browser.
          if (releaseBrowserLock(sessionId)) {
            console.log(`[Session ${sessionId}] Released browser lock (idle eviction)`);
          }
          // Graceful: let the CLI exit on stdin EOF and flush its transcript —
          // a hard abort here races the flush and can truncate the session
          // JSONL tail, silently losing the latest turns on the next resume.
          await data.process.stop({ graceful: true });
          console.log(
            `[Session ${sessionId}] Evicted idle session process (idle ${Math.round((Date.now() - data.session.lastActivity.getTime()) / 60_000)}m)`
          );
        } catch (error) {
          console.error(`[Session ${sessionId}] Idle eviction failed:`, error);
        } finally {
          data.eviction = null;
        }
      })();
      evictions.push(data.eviction);
    }
    await Promise.all(evictions);
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((data) => data.session);
  }

  isSessionRunning(sessionId: string): boolean {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    return sessionData.process.isRunning();
  }

  /**
   * Terminal frames of the session's most recent turn, for a WebSocket
   * subscriber that attached after the turn already ended. Empty when the
   * session is live mid-turn (frames arrive normally) or cold.
   */
  getLateJoinReplay(sessionId: string): unknown[] {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return [];
    return sessionData.process.getLateJoinReplay();
  }

  // Reads persistence only — never resumes an evicted session the way
  // getSession does. null = unknown session.
  getSessionCapabilityGrants(sessionId: string): Array<'subagents' | 'workflows'> | null {
    return this.persistence.getSessionCapabilityGrants(sessionId);
  }

  async interruptSession(sessionId: string): Promise<{ found: boolean; discardedUuids: string[] }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      return { found: false, discardedUuids: [] };
    }

    const outcome = await sessionData.process.interrupt();
    return { found: true, discardedUuids: outcome.discardedUuids };
  }

  /**
   * Stop all active sessions. Used for graceful shutdown.
   */
  async stopAll(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    const sessionIds = Array.from(this.sessions.keys());
    console.log(`Stopping ${sessionIds.length} active session(s)...`);

    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          const sessionData = this.sessions.get(sessionId);
          if (sessionData) {
            // Graceful shutdown: these sessions will be resumed after the
            // container restarts, so their transcripts must be flushed.
            await sessionData.process.dispose({ graceful: true });
            sessionData.subscribers.clear();
          }
        } catch (error) {
          console.error(`Error stopping session ${sessionId}:`, error);
        }
      })
    );

    this.sessions.clear();
    console.log('All sessions stopped.');
  }
}
