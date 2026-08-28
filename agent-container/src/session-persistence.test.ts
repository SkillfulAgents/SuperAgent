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

  describe('saveSessionChecked', () => {
    const record = (sessionId: string, extra: Record<string, unknown> = {}) => ({
      sessionId,
      claudeSessionId: sessionId,
      workingDirectory: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      ...extra,
    })

    it('throws when the parent directory is missing and records nothing', async () => {
      vi.resetModules()
      vi.stubEnv('SUPERAGENT_SESSIONS_FILE', path.join(testDirectory, 'missing', 'sessions.json'))
      const { SessionPersistence } = await import('./session-persistence')
      const persistence = new SessionPersistence()

      expect(() => persistence.saveSessionChecked(record('fork-1'))).toThrow()
      expect(persistence.getSession('fork-1')).toBeNull()
      expect(() => persistence.saveSession(record('fork-1'))).not.toThrow() // the swallowing path is unchanged
    })

    it('restores the previous entry when overwriting fails', async () => {
      const dir = path.join(testDirectory, 'locked')
      fs.mkdirSync(dir)
      const file = path.join(dir, 'sessions.json')
      fs.writeFileSync(file, JSON.stringify({ 'src-1': record('src-1', { model: 'old' }) }))
      vi.resetModules()
      vi.stubEnv('SUPERAGENT_SESSIONS_FILE', file)
      const { SessionPersistence } = await import('./session-persistence')
      const persistence = new SessionPersistence()
      expect(persistence.getSession('src-1')?.model).toBe('old')

      fs.chmodSync(dir, 0o500) // atomic write needs to create a temp file here
      try {
        expect(() => persistence.saveSessionChecked(record('src-1', { model: 'new' }))).toThrow()
        expect(persistence.getSession('src-1')?.model).toBe('old')
      } finally {
        fs.chmodSync(dir, 0o700)
      }
    })
  })
});
