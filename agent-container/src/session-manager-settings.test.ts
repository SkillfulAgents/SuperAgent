import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './session-manager';
import { SESSION_RETENTION_DAYS } from './claude-settings-schema';

describe('SessionManager — Claude settings provisioning', () => {
  let baseDir: string;
  let settingsPath: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-settings-'));
    settingsPath = path.join(baseDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes cleanupPeriodDays into $CLAUDE_CONFIG_DIR/settings.json', () => {
    new SessionManager(baseDir);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.cleanupPeriodDays).toBe(SESSION_RETENTION_DAYS);
  });

  it('merges into an existing settings.json without clobbering other keys', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ cleanupPeriodDays: 30, includeCoAuthoredBy: false })
    );

    new SessionManager(baseDir);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.cleanupPeriodDays).toBe(SESSION_RETENTION_DAYS);
    expect(settings.includeCoAuthoredBy).toBe(false);
  });

  it('leaves the file untouched when already correct', () => {
    new SessionManager(baseDir);
    const firstMtime = fs.statSync(settingsPath).mtimeMs;

    new SessionManager(baseDir);
    const secondMtime = fs.statSync(settingsPath).mtimeMs;

    expect(secondMtime).toBe(firstMtime);
  });
});
