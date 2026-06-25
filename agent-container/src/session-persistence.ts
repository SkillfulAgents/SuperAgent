import * as fs from 'fs';
import { writeFileAtomicSync } from './atomic-file';
import type { EffortLevel } from './types';

interface SessionMetadata {
  sessionId: string;
  claudeSessionId: string;
  workingDirectory: string;
  createdAt: string;
  lastActivity: string;
  systemPrompt?: string;
  modelPromptHints?: string[];
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

const SESSIONS_FILE = '/workspace/.superagent-sessions.json';

export class SessionPersistence {
  private sessions: Map<string, SessionMetadata> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        const sessions = JSON.parse(data);
        this.sessions = new Map(Object.entries(sessions));
        console.log(`Loaded ${this.sessions.size} persisted sessions`);
      }
    } catch (error) {
      console.error('Error loading persisted sessions:', error);
      this.sessions = new Map();
    }
  }

  private save(): void {
    try {
      const data = Object.fromEntries(this.sessions.entries());
      // Atomic temp-file + rename (SUP-310): this map is rewritten on every
      // message (updateLastActivity), and a container force-stop mid-write would
      // otherwise tear the file — making the next load() swallow the parse error
      // and silently wipe ALL session metadata. The atomic write guarantees the
      // previous good file survives an interrupted write. /workspace is fully
      // bind-mounted, so the rename is same-filesystem and reaches the host.
      writeFileAtomicSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Error saving persisted sessions:', error);
    }
  }

  saveSession(metadata: SessionMetadata): void {
    this.sessions.set(metadata.sessionId, metadata);
    this.save();
  }

  getSession(sessionId: string): SessionMetadata | null {
    return this.sessions.get(sessionId) || null;
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.save();
  }

  updateLastActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  updateEffort(sessionId: string, effort: EffortLevel | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.effort = effort;
      this.save();
    }
  }

  updateModel(sessionId: string, model: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.model = model;
      this.save();
    }
  }
}
