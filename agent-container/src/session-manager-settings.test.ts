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

describe('SessionManager — baked skill merge', () => {
  let baseDir: string;
  let bakedRoot: string;
  let previousBakedSkillsDir: string | undefined;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-skills-'));
    bakedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-baked-'));
    previousBakedSkillsDir = process.env.BAKED_SKILLS_DIR;
    process.env.BAKED_SKILLS_DIR = bakedRoot;
  });

  afterEach(() => {
    if (previousBakedSkillsDir === undefined) delete process.env.BAKED_SKILLS_DIR;
    else process.env.BAKED_SKILLS_DIR = previousBakedSkillsDir;
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(bakedRoot, { recursive: true, force: true });
  });

  it('copies baked skills into CLAUDE_CONFIG_DIR/skills for discovery', () => {
    const baked = path.join(bakedRoot, 'replicate');
    fs.mkdirSync(baked, { recursive: true });
    fs.writeFileSync(path.join(baked, 'SKILL.md'), '---\nname: media-generation\n---\n');

    new SessionManager(baseDir);

    const dest = path.join(baseDir, '.claude', 'skills', 'replicate', 'SKILL.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toContain('media-generation');
  });

  it('leaves workspace-authored skills that are not baked', () => {
    const custom = path.join(baseDir, '.claude', 'skills', 'my-custom');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), 'custom');

    const baked = path.join(bakedRoot, 'replicate');
    fs.mkdirSync(baked, { recursive: true });
    fs.writeFileSync(path.join(baked, 'SKILL.md'), 'baked');

    new SessionManager(baseDir);

    expect(fs.readFileSync(path.join(custom, 'SKILL.md'), 'utf-8')).toBe('custom');
  });

  // The destination is the directory the app's Skills list reads and agent templates
  // publish, so only named skills land there — a new directory in the image must not
  // start appearing in every workspace, and a skill's supporting payload must not ride
  // along into published templates.
  it('copies only named skills, without their template payloads', () => {
    const dashboards = path.join(bakedRoot, 'dashboards', 'templates', 'react-vite');
    fs.mkdirSync(dashboards, { recursive: true });
    fs.writeFileSync(path.join(bakedRoot, 'dashboards', 'SKILL.md'), 'dashboards');
    fs.writeFileSync(path.join(dashboards, 'package.json'), '{}');

    const unlisted = path.join(bakedRoot, 'not-a-shipped-skill');
    fs.mkdirSync(unlisted, { recursive: true });
    fs.writeFileSync(path.join(unlisted, 'SKILL.md'), 'nope');

    new SessionManager(baseDir);

    const skillsDir = path.join(baseDir, '.claude', 'skills');
    expect(fs.existsSync(path.join(skillsDir, 'dashboards', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'dashboards', 'templates'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'not-a-shipped-skill'))).toBe(false);
  });
});
