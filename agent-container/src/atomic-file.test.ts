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

  // forceMode: for two-uid files (the agent .env) the mode must be applied on
  // EVERY write — the rename transfers ownership, so preserving a stray
  // restrictive mode locks the other writer out permanently.
  it.runIf(process.platform !== 'win32')('forceMode overrides an existing restrictive mode', async () => {
    const p = path.join(tmpDir, 'shared.env');
    fs.writeFileSync(p, 'A=1\n');
    fs.chmodSync(p, 0o600);
    await writeFileAtomic(p, 'A=2\n', 0o666, { forceMode: true });
    expect(fs.statSync(p).mode & 0o777).toBe(0o666);
  });

  it.runIf(process.platform !== 'win32')('forceMode applies the exact mode on create (not umask-reduced)', async () => {
    const p = path.join(tmpDir, 'fresh.env');
    await writeFileAtomic(p, 'A=1\n', 0o666, { forceMode: true });
    expect(fs.statSync(p).mode & 0o777).toBe(0o666);
  });

  // Ownership preservation: the rename replaces the inode, which would hand
  // the file to this process's uid:gid. Group is the one dimension testable
  // without root — a process may chgrp a file it owns to any of its
  // supplementary groups.
  it.runIf(process.platform !== 'win32')('restores the file group across an atomic overwrite (async)', async () => {
    const altGroup = process.getgroups?.().find((g) => g !== process.getgid?.());
    if (altGroup === undefined) return; // single-group environment — nothing to assert
    const p = path.join(tmpDir, 'grp.txt');
    fs.writeFileSync(p, 'v1');
    fs.chownSync(p, process.getuid!(), altGroup);

    await writeFileAtomic(p, 'v2');

    expect(fs.readFileSync(p, 'utf-8')).toBe('v2');
    expect(fs.statSync(p).gid).toBe(altGroup);
  });

  it.runIf(process.platform !== 'win32')('restores the file group across an atomic overwrite (sync)', () => {
    const altGroup = process.getgroups?.().find((g) => g !== process.getgid?.());
    if (altGroup === undefined) return;
    const p = path.join(tmpDir, 'grp-sync.txt');
    fs.writeFileSync(p, 'v1');
    fs.chownSync(p, process.getuid!(), altGroup);

    writeFileAtomicSync(p, 'v2');

    expect(fs.statSync(p).gid).toBe(altGroup);
  });
});
