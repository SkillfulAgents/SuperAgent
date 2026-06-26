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
    let data: string;
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return; // fresh container — empty map
      data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    } catch (error) {
      // Genuine IO error reading an existing file. Start empty but leave the
      // file untouched (we can't preserve what we couldn't read, and must not
      // assume it's safe to overwrite).
      console.error('Error reading persisted sessions:', error);
      this.sessions = new Map();
      return;
    }

    try {
      const sessions = JSON.parse(data);
      this.sessions = new Map(Object.entries(sessions));
      console.log(`Loaded ${this.sessions.size} persisted sessions`);
    } catch (error) {
      // Corrupt JSON (e.g. a torn write from an older build, or disk damage). Do
      // NOT silently overwrite it on the next save() — preserve it aside for
      // recovery first, then start empty (fail-closed, matching the host stores).
      console.error('Corrupt persisted sessions; preserving aside and starting empty:', error);
      try {
        fs.renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.corrupt-${Date.now()}`);
      } catch (renameErr) {
        console.error('Failed to preserve corrupt sessions file:', renameErr);
      }
      this.sessions = new Map();
    }
  }

  private save(): void {
    try {
      const data = Object.fromEntries(this.sessions.entries());
      // Atomic temp-file + rename: this map is rewritten on every
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
