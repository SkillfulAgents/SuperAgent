import * as fs from 'fs';
import * as path from 'path';

interface SessionMetadata {
  sessionId: string;
  claudeSessionId: string;
  workingDirectory: string;
  createdAt: string;
  lastActivity: string;
  systemPrompt?: string;
  availableEnvVars?: string[];
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
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
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
}
