import { v4 as uuidv4 } from 'uuid';
import { Session, SDKMessage, CreateSessionRequest } from './types';
import { ClaudeCodeProcess } from './claude-code';
import { SessionPersistence } from './session-persistence';
import { EventEmitter } from 'events';
import * as fs from 'fs';

interface SessionData {
  session: Session;
  process: ClaudeCodeProcess;
  messages: SDKMessage[];
  subscribers: Set<(message: SDKMessage) => void>;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionData> = new Map();
  private baseWorkingDirectory: string;
  private persistence: SessionPersistence;

  constructor(baseWorkingDirectory: string = '/workspace') {
    super();
    this.baseWorkingDirectory = baseWorkingDirectory;
    this.persistence = new SessionPersistence();

    // Ensure base directory exists
    if (!fs.existsSync(this.baseWorkingDirectory)) {
      fs.mkdirSync(this.baseWorkingDirectory, { recursive: true });
    }

    // Ensure .claude/skills directory exists for Skills support
    const skillsDir = `${this.baseWorkingDirectory}/.claude/skills`;
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
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
      availableEnvVars: request.availableEnvVars,
      model: request.model,
      browserModel: request.browserModel,
    });

    // Promise to capture Claude's session ID (emitted after first message is sent)
    const claudeSessionIdPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for Claude session ID'));
      }, 30000); // 30 second timeout

      process.once('claude-session-id', (claudeSessionId: string) => {
        clearTimeout(timeout);
        resolve(claudeSessionId);
      });

      process.once('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Start the Claude Code process
    await process.start();

    // Send the initial message - this triggers Claude to emit the session ID
    await process.sendMessage(request.initialMessage);

    // Wait for Claude's session ID
    const claudeSessionId = await claudeSessionIdPromise;
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
      availableEnvVars: request.availableEnvVars,
    };

    const sessionData: SessionData = {
      session,
      process,
      messages: [],
      subscribers: new Set(),
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
      availableEnvVars: request.availableEnvVars,
      model: request.model,
      browserModel: request.browserModel,
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
        availableEnvVars: persisted.availableEnvVars,
        model: persisted.model,
        browserModel: persisted.browserModel,
      });

      const session: Session = {
        id: sessionId,
        createdAt: new Date(persisted.createdAt),
        lastActivity: new Date(),
        workingDirectory: persisted.workingDirectory,
        systemPrompt: persisted.systemPrompt,
        availableEnvVars: persisted.availableEnvVars,
      };

      const sessionData: SessionData = {
        session,
        process,
        messages: [],
        subscribers: new Set(),
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
      await process.start();

      console.log(`Successfully resumed session ${sessionId}`);
      return sessionData;
    } catch (error) {
      console.error(`Failed to resume session ${sessionId}:`, error);
      return undefined;
    }
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

  async sendMessage(sessionId: string, content: string): Promise<void> {
    let sessionData = this.sessions.get(sessionId);

    // Try to resume if not in memory
    if (!sessionData) {
      sessionData = await this.resumeSession(sessionId);
      if (!sessionData) {
        throw new Error(`Session ${sessionId} not found`);
      }
    }

    // Update last activity
    sessionData.session.lastActivity = new Date();
    this.persistence.updateLastActivity(sessionId);

    // Send to Claude Code process (messages are stored via handleMessage)
    await sessionData.process.sendMessage(content);
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

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((data) => data.session);
  }

  isSessionRunning(sessionId: string): boolean {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    return sessionData.process.isRunning();
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      return false;
    }

    await sessionData.process.interrupt();
    return true;
  }

  /**
   * Stop all active sessions. Used for graceful shutdown.
   */
  async stopAll(): Promise<void> {
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
