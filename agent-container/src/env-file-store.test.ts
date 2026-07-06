/**
 * Container-side cross-process-safe .env writes. Must stay
 * protocol-compatible with the host's withCrossProcessFileLock / writeFileAtomic
 * (same `<target>.lock` O_EXCL convention, same atomic temp+rename).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  writeFileAtomic,
  withEnvFileLock,
  readEnvFileOrNull,
  upsertEnvContent,
  updateEnvFileEntry,
} from './env-file-store';

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

/** An NFS stale-file-handle error, as raised after another client rename-replaces
 *  the file this client has a cached lookup for. */
function estale(): NodeJS.ErrnoException {
  return Object.assign(new Error('ESTALE: stale file handle'), { code: 'ESTALE' });
}

function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
    code: 'ENOENT',
  });
}

/** Fail fs.promises.readFile for `target` the first `times` calls (-1 = always),
 *  pass everything else (the lock release reads `<target>.lock`) through. */
function failReadsOf(target: string, err: () => Error, times: number) {
  const real = fs.promises.readFile.bind(fs.promises);
  let remaining = times;
  return vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: unknown, ...args: unknown[]) => {
    if (p === target && (remaining === -1 || remaining-- > 0)) throw err();
    return (real as any)(p, ...args);
  }) as typeof fs.promises.readFile);
}

describe('readEnvFileOrNull', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the file content', async () => {
    fs.writeFileSync(envPath, 'A=1\n');
    expect(await readEnvFileOrNull(envPath)).toBe('A=1\n');
  });

  it('returns null when the file is genuinely absent', async () => {
    expect(await readEnvFileOrNull(envPath)).toBeNull();
  });

  it('retries through a transient ESTALE and returns the content', async () => {
    fs.writeFileSync(envPath, 'A=1\n');
    failReadsOf(envPath, estale, 2);
    expect(await readEnvFileOrNull(envPath)).toBe('A=1\n');
  });

  it('retries through a transient ENOENT (mid-rename lookup) and returns the content', async () => {
    fs.writeFileSync(envPath, 'A=1\n');
    failReadsOf(envPath, () => enoent(envPath), 1);
    expect(await readEnvFileOrNull(envPath)).toBe('A=1\n');
  });

  it(
    'THROWS on a persistent non-ENOENT error — never reports an existing file as absent',
    { timeout: 10_000 },
    async () => {
      // Fail-closed is the load-bearing property: reporting an unreadable .env as
      // "absent" made the caller merge into empty and atomically wipe every secret.
      fs.writeFileSync(envPath, 'A=1\n');
      failReadsOf(envPath, estale, -1);
      await expect(readEnvFileOrNull(envPath)).rejects.toMatchObject({ code: 'ESTALE' });
    }
  );
});

describe('upsertEnvContent', () => {
  const hostWritten = [
    '# Superagent Secrets',
    '# Format: ENV_VAR=value  # Display Name',
    '',
    'SUPABASE_URL=https://x.supabase.co',
    'SUPABASE_SERVICE_ROLE_KEY=eyJhbGc  # Supabase Key',
    'CLICKHOUSE_PASSWORD="p w"',
    '',
  ].join('\n');

  it('appends a new key, preserving every existing line byte-for-byte', () => {
    const result = upsertEnvContent(hostWritten, 'APOLLO_API_KEY', 'tok-123');
    expect(result).toBe(hostWritten + 'APOLLO_API_KEY="tok-123"\n');
  });

  it('replaces an existing key in place, keeping its display-name comment', () => {
    const result = upsertEnvContent(hostWritten, 'SUPABASE_SERVICE_ROLE_KEY', 'newkey');
    expect(result).toContain('SUPABASE_SERVICE_ROLE_KEY="newkey"  # Supabase Key');
    // Everything else untouched.
    expect(result).toContain('# Superagent Secrets');
    expect(result).toContain('SUPABASE_URL=https://x.supabase.co');
    expect(result).toContain('CLICKHOUSE_PASSWORD="p w"');
  });

  it('does not treat a # inside a quoted value as a comment', () => {
    const result = upsertEnvContent('K="a#b"\nOTHER=1\n', 'K', 'new');
    expect(result).toBe('K="new"\nOTHER=1\n');
  });

  it('drops duplicate definitions of the updated key, keeps everything else', () => {
    const result = upsertEnvContent('A=1\nB=2\nA=3\n', 'A', 'x');
    expect(result).toBe('A="x"\nB=2\n');
  });

  it('handles empty content', () => {
    expect(upsertEnvContent('', 'K', 'v')).toBe('K="v"\n');
  });

  it('adds a trailing newline when the source lacks one', () => {
    expect(upsertEnvContent('A=1', 'B', 'v')).toBe('A=1\nB="v"\n');
  });

  it('escapes quotes and newlines so a value cannot break the line structure', () => {
    const result = upsertEnvContent('', 'K', 'say "hi"\nline2');
    expect(result).toBe('K="say \\"hi\\"\\nline2"\n');
  });

  it('escapes backslashes (matching the host serializer, so values round-trip)', () => {
    const result = upsertEnvContent('', 'K', 'a\\b');
    expect(result).toBe('K="a\\\\b"\n');
  });

  it('does not match keys of which the target is a prefix/suffix', () => {
    const result = upsertEnvContent('MY_KEY=1\nKEY_2=2\n', 'KEY', 'v');
    expect(result).toBe('MY_KEY=1\nKEY_2=2\nKEY="v"\n');
  });
});

describe('updateEnvFileEntry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adding a key NEVER drops existing secrets (the .env wipe regression)', async () => {
    // Reproduces the prod wipe: a host-format .env full of secrets, then the
    // container upserts one new key via POST /env. Every prior secret must survive.
    const before = [
      '# Superagent Secrets',
      '# Format: ENV_VAR=value  # Display Name',
      '',
      'SUPABASE_URL=https://x.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=eyJhbGc  # Supabase Key',
      'STRIPE_SECRET_KEY=sk_live_123',
      '',
    ].join('\n');
    fs.writeFileSync(envPath, before);

    await updateEnvFileEntry(envPath, 'APOLLO_API_KEY', 'tok-123');

    const after = fs.readFileSync(envPath, 'utf-8');
    expect(after).toBe(before + 'APOLLO_API_KEY="tok-123"\n');
  });

  it(
    'fails closed: a persistently unreadable .env aborts the update and leaves the file untouched',
    { timeout: 10_000 },
    async () => {
      const before = 'SUPABASE_URL=https://x.supabase.co\n';
      fs.writeFileSync(envPath, before);
      failReadsOf(envPath, estale, -1);

      await expect(
        updateEnvFileEntry(envPath, 'APOLLO_API_KEY', 'tok')
      ).rejects.toMatchObject({ code: 'ESTALE' });
      vi.restoreAllMocks();

      expect(fs.readFileSync(envPath, 'utf-8')).toBe(before);
      // And the lock was released despite the failure.
      expect(fs.existsSync(`${envPath}.lock`)).toBe(false);
    }
  );

  it('creates a missing .env and works end-to-end', async () => {
    await updateEnvFileEntry(envPath, 'K', 'v');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('K="v"\n');
  });

  it.runIf(process.platform !== 'win32')(
    'creates the file world-writable (exact 0o666) so the host — a different uid — can write it too',
    async () => {
      await updateEnvFileEntry(envPath, 'K', 'v');
      expect(fs.statSync(envPath).mode & 0o777).toBe(0o666);
    }
  );

  it.runIf(process.platform !== 'win32')('heals a stuck restrictive mode back to 0o666', async () => {
    // The atomic rename transfers ownership; preserving a stray 0o600 on this
    // two-uid file would lock the host writer out of its own next update.
    fs.writeFileSync(envPath, 'A=1\n');
    fs.chmodSync(envPath, 0o600);
    await updateEnvFileEntry(envPath, 'K', 'v');
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o666);
  });

  it('concurrent upserts of distinct keys all survive', async () => {
    fs.writeFileSync(envPath, 'SEED=1\n');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => updateEnvFileEntry(envPath, `KEY_${i}`, `v${i}`))
    );
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('SEED=1');
    for (let i = 0; i < 10; i++) expect(content).toContain(`KEY_${i}="v${i}"`);
  });
});
