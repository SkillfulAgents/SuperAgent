/**
 * existingMode stat scoping in the atomic writers: a non-ENOENT stat error
 * (NFS ESTALE after a cross-client rename, EIO) means "state unknown", not
 * "file absent" — the write must FAIL instead of proceeding as a create, which
 * would silently reset the target's permissions to the caller's default mode
 * (the 0o666 → 0o600 flip observed in the /workspace/.env wipe).
 *
 * Lives in its own file with a module-level fs mock: Node's builtin module
 * properties are non-configurable, so vi.spyOn cannot patch fs.statSync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const statFailure = vi.hoisted(() => ({ active: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const estale = () =>
    Object.assign(new Error('ESTALE: stale file handle'), { code: 'ESTALE' });
  return {
    ...actual,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      if (statFailure.active) throw estale();
      return actual.statSync(...args);
    }) as typeof actual.statSync,
    promises: {
      ...actual.promises,
      stat: (async (...args: Parameters<typeof actual.promises.stat>) => {
        if (statFailure.active) throw estale();
        return actual.promises.stat(...args);
      }) as typeof actual.promises.stat,
    },
  };
});

import * as fs from 'fs';
import { writeFileAtomic, writeFileAtomicSync } from './atomic-file';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-statscope-')));
});

afterEach(() => {
  statFailure.active = false;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function leftoverTmpFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

describe('existingMode stat is ENOENT-scoped (fail-closed)', () => {
  it('async: a non-ENOENT stat error fails the write and leaves the target untouched', async () => {
    const p = path.join(tmpDir, 'f.txt');
    fs.writeFileSync(p, 'precious');

    statFailure.active = true;
    await expect(writeFileAtomic(p, 'replacement')).rejects.toMatchObject({ code: 'ESTALE' });
    statFailure.active = false;

    expect(fs.readFileSync(p, 'utf-8')).toBe('precious');
    expect(leftoverTmpFiles(tmpDir)).toEqual([]);
  });

  it('sync: a non-ENOENT stat error fails the write and leaves the target untouched', () => {
    const p = path.join(tmpDir, 'f-sync.txt');
    fs.writeFileSync(p, 'precious');

    statFailure.active = true;
    expect(() => writeFileAtomicSync(p, 'replacement')).toThrow('ESTALE');
    statFailure.active = false;

    expect(fs.readFileSync(p, 'utf-8')).toBe('precious');
    expect(leftoverTmpFiles(tmpDir)).toEqual([]);
  });

  it('a genuinely absent target still creates with the requested mode', async () => {
    // ENOENT must keep meaning "create" — the scoping only rejects OTHER errors.
    const p = path.join(tmpDir, 'new.txt');
    await writeFileAtomic(p, 'fresh', 0o600);
    expect(fs.readFileSync(p, 'utf-8')).toBe('fresh');
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });
});
