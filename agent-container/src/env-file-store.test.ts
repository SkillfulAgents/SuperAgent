/**
 * Container-side cross-process-safe .env writes. Must stay
 * protocol-compatible with the host's withCrossProcessFileLock / writeFileAtomic
 * (same `<target>.lock` O_EXCL convention, same atomic temp+rename).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeFileAtomic, withEnvFileLock } from './env-file-store';

let tmpDir: string;
let envPath: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-store-')));
  envPath = path.join(tmpDir, '.env');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes content and leaves no temp file behind', async () => {
    await writeFileAtomic(envPath, 'KEY=value\n');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('KEY=value\n');
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed write leaves the previous good file intact', async () => {
    const target = path.join(tmpDir, 'is-a-dir');
    fs.mkdirSync(target);
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('applies the requested mode', async () => {
    await writeFileAtomic(envPath, 'KEY=v\n', 0o600);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
});

describe('withEnvFileLock', () => {
  it('uses the <target>.lock convention shared with the host', async () => {
    let seen = false;
    await withEnvFileLock(envPath, async () => {
      seen = fs.existsSync(`${envPath}.lock`);
    });
    expect(seen).toBe(true);
    expect(fs.existsSync(`${envPath}.lock`)).toBe(false); // released
  });

  it('serializes concurrent read-modify-write so every key survives', async () => {
    // Models the app + container both updating .env: each appends a distinct key
    // under the shared lock. Without serialization they would clobber.
    fs.writeFileSync(envPath, '');
    const upsert = (key: string) =>
      withEnvFileLock(envPath, async () => {
        const cur = fs.readFileSync(envPath, 'utf-8');
        await new Promise((r) => setTimeout(r, 1));
        await writeFileAtomic(envPath, `${cur}${key}=1\n`);
      });

    await Promise.all(Array.from({ length: 12 }, (_, i) => upsert(`KEY_${i}`)));

    const lines = fs.readFileSync(envPath, 'utf-8').trim().split('\n').sort();
    expect(lines).toEqual(Array.from({ length: 12 }, (_, i) => `KEY_${i}=1`).sort());
  });

  it('releases the lock even when fn throws', async () => {
    await expect(
      withEnvFileLock(envPath, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(`${envPath}.lock`)).toBe(false);
  });

  it('steals a stale lock left by a crashed writer', async () => {
    const lockPath = `${envPath}.lock`;
    fs.writeFileSync(lockPath, '99999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    let ran = false;
    await withEnvFileLock(envPath, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
