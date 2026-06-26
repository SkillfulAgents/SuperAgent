/**
 * Container-side atomic file writes (shared by the .env store and the
 * /workspace session-persistence map). Sensitive infra: a regression re-opens
 * the torn-write data-loss bug-class, so the crash-safety properties are covered
 * for both the async and sync writers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeFileAtomic, writeFileAtomicSync } from './atomic-file';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-file-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Sibling `.tmp` files the writer creates; none should survive a call. */
function leftoverTmpFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

describe('writeFileAtomicSync', () => {
  it('writes content and leaves no temp file behind', () => {
    const p = path.join(tmpDir, 'sessions.json');
    writeFileAtomicSync(p, JSON.stringify({ a: 1 }));
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ a: 1 });
    expect(leftoverTmpFiles(tmpDir)).toEqual([]);
  });

  it('overwrites an existing file atomically (full replace)', () => {
    const p = path.join(tmpDir, 'sessions.json');
    fs.writeFileSync(p, JSON.stringify({ old: true }));
    writeFileAtomicSync(p, JSON.stringify({ fresh: true }));
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ fresh: true });
  });

  it('a failed write leaves the previous good file intact and no temp file', () => {
    // Target is a directory → the final rename(tmp -> target) fails; the writer
    // must clean up its temp file and surface the error without touching the
    // existing data. This is the "partial .tmp never replaces a good file"
    // crash-safety property that prevents the silent wipe on next load().
    const target = path.join(tmpDir, 'is-a-dir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'precious');

    expect(() => writeFileAtomicSync(target, 'garbage')).toThrow();

    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('precious');
    expect(leftoverTmpFiles(tmpDir)).toEqual([]);
  });

  it('throws when the parent directory does not exist (no silent no-op)', () => {
    const p = path.join(tmpDir, 'missing', 'x.json');
    expect(() => writeFileAtomicSync(p, '{}')).toThrow();
  });

  it.runIf(process.platform !== 'win32')('applies the requested mode on create', () => {
    const p = path.join(tmpDir, 'secret.txt');
    writeFileAtomicSync(p, 'x', 0o600);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('preserves an existing file mode on overwrite', () => {
    const p = path.join(tmpDir, 'preserve.txt');
    fs.writeFileSync(p, 'first');
    fs.chmodSync(p, 0o640);
    // Pass a different mode — overwrite must NOT change the existing perms.
    writeFileAtomicSync(p, 'second', 0o600);
    expect(fs.statSync(p).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(p, 'utf-8')).toBe('second');
  });
});

describe('writeFileAtomic (async)', () => {
  it('writes content and leaves no temp file behind', async () => {
    const p = path.join(tmpDir, 'a.json');
    await writeFileAtomic(p, JSON.stringify({ ok: true }));
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ ok: true });
    expect(leftoverTmpFiles(tmpDir)).toEqual([]);
  });

  it('a failed write leaves the previous good file intact', async () => {
    const target = path.join(tmpDir, 'is-a-dir');
    fs.mkdirSync(target);
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(leftoverTmpFiles(tmpDir)).toEqual([]);
  });
});
