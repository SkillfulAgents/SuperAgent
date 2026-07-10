import { v4 as uuidv4 } from 'uuid';
import type { UUID } from 'crypto';
import { Session, SDKMessage, CreateSessionRequest, EffortLevel } from './types';
import { ClaudeCodeProcess } from './claude-code';
import { SessionPersistence } from './session-persistence';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { releaseBrowserLock } from './browser-state';
import { claudeSettingsSchema, SESSION_RETENTION_DAYS } from './claude-settings-schema';

interface SessionData {
  session: Session;
  process: ClaudeCodeProcess;
  messages: SDKMessage[];
  subscribers: Set<(message: SDKMessage) => void>;
  runtimeState: 'idle' | 'busy';
  stateEventsSeen: boolean;
  // Cleared on sendMessage; set on result. Mirrors message-persister: bare
  // session_state_changed:idle without a result for this turn is ignored
  // (stale idle racing a fresh message).
  lastResultSubtype: string | null;
  activeBackgroundTaskIds: Set<string>;
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
  private baseWorkingDirectory: string;
  private persistence: SessionPersistence;
  private readonly idleEvictionMs: number;
  private readonly automatedIdleEvictionMs: number;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    baseWorkingDirectory: string = '/workspace',
    options?: { idleEvictionMs?: number; automatedIdleEvictionMs?: number }
  ) {
    super();
    this.baseWorkingDirectory = baseWorkingDirectory;
    this.persistence = new SessionPersistence();
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
      }, IDLE_EVICTION_POLL_MS);
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

    // Start the Claude Code process
    await process.start();

    // Send the initial message - this triggers Claude to emit the session ID
    await process.sendMessage(request.initialMessage, request.initialMessageUuid);

    // Wait for init to complete (session ID + slash commands)
    const claudeSessionId = await initCompletePromise;
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
      messages: [],
      subscribers: new Set(),
      runtimeState: 'busy',
      stateEventsSeen: false,
      lastResultSubtype: null,
      activeBackgroundTaskIds: new Set(),
      eviction: null,
    };

    // Set up event listeners
    process.on('message', (message: SDKMessage) => {
      this.handleMessage(sessionId, message);
    });

    process.on('stderr', (error: string) => {
      console.error(`[Session ${sessionId}] stderr:`, error);
    });

    process.on('exit', (code: number | null) => {
      console.log(`Session ${sessionId} exited with code ${code}`);
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
    });

    this.sessions.set(sessionId, sessionData);

    console.log(`Created session ${sessionId} with working directory ${workingDirectory}`);
    return session;
  }

  private async resumeSession(sessionId: string): Promise<SessionData | undefined> {
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
      });

      const session: Session = {
        id: sessionId,
        createdAt: new Date(persisted.createdAt),
        lastActivity: new Date(),
        workingDirectory: persisted.workingDirectory,
        systemPrompt: persisted.systemPrompt,
        modelPromptHints: persisted.modelPromptHints,
        availableEnvVars: persisted.availableEnvVars,
      };

      const sessionData: SessionData = {
        session,
        process,
        messages: [],
        subscribers: new Set(),
        // Born-idle: a bare getSession() resume gets no turn (no result, never
        // idle), so born-busy would park the process beyond the reaper forever.
        // sendMessage sets busy itself right after resuming.
        runtimeState: 'idle',
        stateEventsSeen: false,
        lastResultSubtype: null,
        activeBackgroundTaskIds: new Set(),
        eviction: null,
      };

      // Set up event listeners (same as createSession)
      process.on('message', (message: SDKMessage) => {
        this.handleMessage(sessionId, message);
      });

      process.on('stderr', (error: string) => {
        console.error(`[Session ${sessionId}] stderr:`, error);
      });

      process.on('exit', (code: number | null) => {
        console.log(`Resumed session ${sessionId} exited with code ${code}`);
      });

      this.sessions.set(sessionId, sessionData);

      // Start the process (which will resume the Claude session)
      // Note: slash commands are captured later when init event fires via WebSocket
      await process.start();

      console.log(`Successfully resumed session ${sessionId}`);
      return sessionData;
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

    // Stop the process
    await sessionData.process.stop();

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
    options?: { effort?: EffortLevel; model?: string; shouldQuery?: boolean }
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
    sessionData.runtimeState = 'busy';
    sessionData.lastResultSubtype = null;

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

  getMessages(sessionId: string): SDKMessage[] {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return [];
    return [...sessionData.messages];
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

    // Store the message
    sessionData.messages.push(message);

    this.trackRuntimeState(sessionData, message);

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

  // Track whether the session is settled (safe to evict) from the SDK stream.
  // session_state_changed is authoritative when present; idle is only accepted
  // after a result for this turn (same gate as message-persister). 'result' is
  // the idle fallback when no state events exist. Background tasks block eviction.
  private trackRuntimeState(sessionData: SessionData, message: SDKMessage): void {
    const msg = message as {
      type?: string;
      subtype?: string;
      state?: string;
      task_id?: string;
      status?: string;
      patch?: { status?: string };
    };

    if (msg.type === 'result') {
      sessionData.lastResultSubtype = msg.subtype ?? 'unknown';
      if (!sessionData.stateEventsSeen) {
        sessionData.runtimeState = 'idle';
      }
      return;
    }

    if (msg.type === 'system') {
      if (msg.subtype === 'session_state_changed') {
        sessionData.stateEventsSeen = true;
        if (msg.state === 'idle') {
          // Ignore stale idle with no result for this turn (race with sendMessage).
          if (sessionData.lastResultSubtype !== null) {
            sessionData.runtimeState = 'idle';
          }
        } else {
          sessionData.runtimeState = 'busy';
        }
      } else if (msg.subtype === 'task_started' && msg.task_id) {
        sessionData.activeBackgroundTaskIds.add(msg.task_id);
      } else if (msg.subtype === 'task_updated' && msg.task_id) {
        const status = msg.patch?.status;
        if (status === 'completed' || status === 'failed' || status === 'killed') {
          sessionData.activeBackgroundTaskIds.delete(msg.task_id);
        }
      } else if (msg.subtype === 'task_notification' && msg.task_id) {
        if (msg.status === 'completed' || msg.status === 'failed' || msg.status === 'killed') {
          sessionData.activeBackgroundTaskIds.delete(msg.task_id);
        }
      }
    } else if (msg.type === 'user' || msg.type === 'assistant') {
      // Any turn traffic means the session is working again.
      sessionData.runtimeState = 'busy';
    }
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
    for (const [sessionId, data] of this.sessions) {
      if (data.eviction) continue; // already evicting
      if (data.runtimeState !== 'idle') continue;
      if (data.activeBackgroundTaskIds.size > 0) continue;
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
          await data.process.stop();
          console.log(
            `[Session ${sessionId}] Evicted idle session process (idle ${Math.round((now - data.session.lastActivity.getTime()) / 60_000)}m)`
          );
        } catch (error) {
          console.error(`[Session ${sessionId}] Idle eviction failed:`, error);
        } finally {
          data.eviction = null;
        }
      })();
      await data.eviction;
    }
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((data) => data.session);
  }

  isSessionRunning(sessionId: string): boolean {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    return sessionData.process.isRunning();
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
            await sessionData.process.stop();
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
