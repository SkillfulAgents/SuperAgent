import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkspaceWatcher } from './workspace-watcher';

const sends: { paths: string[]; down?: string }[] = [];
let failNext = false;
const send = vi.fn(async (paths: string[], down?: string) => {
  sends.push({ paths, down });
  if (failNext) {
    failNext = false;
    throw new Error('host unreachable');
  }
});

const sentFrom = (from = 0) => sends.slice(from).flatMap((s) => s.paths);

// Waits on content, not on send order: macOS can deliver a stale event first.
async function untilSent(path: string, from = 0): Promise<void> {
  await vi.waitFor(() => expect(sentFrom(from)).toContain(path), { timeout: 3_000 });
}

// A write into a folder whose watch is still opening reaches the drawer through the folder's scope.
async function untilCovered(file: string, from: number): Promise<void> {
  const covered = () => sentFrom(from).some((p) => p === '' || p === file || file.startsWith(`${p}/`));
  await vi.waitFor(() => expect(covered()).toBe(true), { timeout: 3_000 });
}

let stopWatcher: (() => void) | undefined;
afterEach(() => {
  stopWatcher?.();
  sends.length = 0;
  send.mockClear();
});

async function start(sender: typeof send = send): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-watch-'));
  const watcher = await startWorkspaceWatcher(root, sender);
  stopWatcher = watcher.stop;
  expect(watcher.down).toBe(false);
  await untilSent('');
  return root;
}

describe('startWorkspaceWatcher', () => {
  it('names the whole workspace at start, then each changed path, never the probe or skipped folders', async () => {
    const root = await start();
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
    fs.writeFileSync(path.join(root, 'notes.md'), 'hi');
    await untilSent('notes.md');

    const made = sends.length;
    fs.mkdirSync(path.join(root, 'out'));
    fs.writeFileSync(path.join(root, 'out', 'report.md'), 'new');
    await untilCovered('out/report.md', made);
    expect(sentFrom().some((p) => p.includes('.file-watch-probe') || p.includes('node_modules'))).toBe(false);
  });

  it('sends one batch at a time, so a failed send is recovered even when changes arrive meanwhile', async () => {
    let rejectHung: (error: Error) => void = () => {};
    const slow = vi.fn((paths: string[]) => {
      sends.push({ paths });
      return paths.includes('a.md') ? new Promise<void>((_, reject) => { rejectHung = reject; }) : Promise.resolve();
    });
    const root = await start(slow as unknown as typeof send);
    fs.writeFileSync(path.join(root, 'a.md'), 'a');
    await untilSent('a.md');
    const inFlight = sends.length;
    fs.writeFileSync(path.join(root, 'b.md'), 'b');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sends).toHaveLength(inFlight);
    rejectHung(new Error('host unreachable'));
    await untilSent('', inFlight);
    expect(sends[inFlight].paths).toEqual(['']);
  });

  it('keeps watching a folder deleted and recreated under the same name', async () => {
    const root = await start();
    fs.mkdirSync(path.join(root, 'out'));
    await untilSent('out');
    const replaced = sends.length;
    fs.rmSync(path.join(root, 'out'), { recursive: true });
    fs.mkdirSync(path.join(root, 'out'));
    await untilSent('out', replaced);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const written = sends.length;
    fs.writeFileSync(path.join(root, 'out', 'b.md'), 'b');
    await untilSent('out/b.md', written);
  });

  it('keeps watching inside a folder whose times were touched', async () => {
    const root = await start();
    fs.mkdirSync(path.join(root, 'out', 'deep'), { recursive: true });
    await untilSent('out');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const touched = sends.length;
    const now = new Date();
    fs.utimesSync(path.join(root, 'out'), now, now);
    fs.writeFileSync(path.join(root, 'out', 'deep', 'c.md'), 'c');
    await untilCovered('out/deep/c.md', touched);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = sends.length;
    fs.writeFileSync(path.join(root, 'out', 'deep', 'd.md'), 'd');
    await untilSent('out/deep/d.md', after);
  });

  it('does not resend after a failed send until something else changes', async () => {
    const root = await start();
    failNext = true;
    fs.writeFileSync(path.join(root, 'a.md'), 'a');
    await untilSent('a.md');
    const failed = sends.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(sends).toHaveLength(failed);
    fs.writeFileSync(path.join(root, 'b.md'), 'b');
    await untilSent('', failed);
    expect(sends[failed].paths).toEqual(['']);
  });

  it('reports itself down and names the whole workspace when it cannot watch', async () => {
    const watcher = await startWorkspaceWatcher(path.join(os.tmpdir(), 'ws-watch-missing', 'nowhere'), send);
    expect(watcher.down).toBe(true);
    expect(sends).toEqual([{ paths: [''], down: expect.stringContaining('ENOENT') }]);
  });
});
