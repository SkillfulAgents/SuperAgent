import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SessionPersistence', () => {
  let testDirectory: string;
  let sessionsFile: string;

  beforeEach(() => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-persistence-'));
    sessionsFile = path.join(testDirectory, 'sessions.json');
    vi.resetModules();
    vi.stubEnv('SUPERAGENT_SESSIONS_FILE', sessionsFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  async function loadPersistence() {
    const { SessionPersistence } = await import('./session-persistence');
    return new SessionPersistence();
  }

  function legacySession(sessionId: string) {
    return {
      sessionId,
      claudeSessionId: `claude-${sessionId}`,
      workingDirectory: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:01.000Z',
      model: 'claude-sonnet-5',
    };
  }

  it('loads pre-catalog session records with an empty subagent catalog', async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ legacy: legacySession('legacy') }));

    const persistence = await loadPersistence();

    expect(persistence.getSession('legacy')).toMatchObject({
      sessionId: 'legacy',
      subagentModels: [],
    });
  });

  it('drops only an invalid record while preserving other resume metadata', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        valid: legacySession('valid'),
        invalid: { ...legacySession('invalid'), speed: 'impossibly-fast' },
      }),
    );

    const persistence = await loadPersistence();

    expect(persistence.getSession('valid')?.claudeSessionId).toBe('claude-valid');
    expect(persistence.getSession('invalid')).toBeNull();
    expect(error).toHaveBeenCalledWith(
      'Dropping invalid persisted session "invalid":',
      expect.any(String),
    );
    expect(fs.existsSync(sessionsFile)).toBe(true);
    expect(fs.readdirSync(testDirectory).some((name) => name.includes('.corrupt-'))).toBe(false);
  });

  it('preserves malformed JSON aside because no records can be recovered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.writeFileSync(sessionsFile, '{not-json');

    const persistence = await loadPersistence();

    expect(persistence.getSession('anything')).toBeNull();
    expect(fs.existsSync(sessionsFile)).toBe(false);
    expect(fs.readdirSync(testDirectory).some((name) => name.startsWith('sessions.json.corrupt-'))).toBe(true);
  });
});
