import * as fs from 'fs';
import * as path from 'path';

/** Folder names never watched, wherever they sit. The host's announcer skips the same and more. */
const SKIPPED_NAMES = new Set(['node_modules', '.git', '.volume-cache', '.venv', '__pycache__', '.browser-profile', '.bun-cache']);
/** The CLI's own folders under .claude change on every turn. Skills are the agent's files. */
const CLAUDE_DIR = '.claude';
const CLAUDE_KEPT = '.claude/skills';
const PROBE_DIR = '.file-watch-probe';
const FLUSH_MS = 200;
const PROBE_TIMEOUT_MS = 2_000;
const SEND_TIMEOUT_MS = 10_000;
/** Past this many changed paths, keep their top-level folders, then the whole workspace. */
const MAX_PATHS = 500;
/** The inotify watch limit is per user on the host kernel, shared with every container on it. */
const MAX_WATCHES = 4_000;
const WHOLE = '';

type Send = (paths: string[], downReason?: string, signal?: AbortSignal) => Promise<unknown>;

function isSkipped(rel: string): boolean {
  if (rel.split('/').some((name) => SKIPPED_NAMES.has(name))) return true;
  return rel.startsWith(`${CLAUDE_DIR}/`) && rel !== CLAUDE_KEPT && !rel.startsWith(`${CLAUDE_KEPT}/`);
}

/**
 * Watch the workspace and send the paths that change, relative to `root`.
 * Folders are watched one by one so skipped trees cost no inotify watches.
 * It proves itself at start (a create, a folder rename, a delete) and names
 * the whole workspace once, so changes made while the container was stopped
 * reach open views. When it cannot watch, it names the whole workspace once,
 * reports itself down, and stops.
 */
export async function startWorkspaceWatcher(root: string, send: Send): Promise<{ stop: () => void; down: boolean }> {
  const watchers = new Map<string, fs.FSWatcher>();
  let pending = new Set<string>();
  const heard = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let sending = false;
  let lostSend = false;
  let stopped = false;
  let down = false;
  let probing = true;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };

  // One send at a time, so a send that fails cannot be covered by a later one that started first.
  // A failed send makes the next one name the whole workspace; it does not retry on its own.
  const flush = () => {
    timer = null;
    if (stopped || sending || pending.size === 0) return;
    const paths = lostSend ? [WHOLE] : [...pending];
    pending = new Set();
    sending = true;
    send(paths, undefined, AbortSignal.timeout(SEND_TIMEOUT_MS)).then(() => { lostSend = false; }, () => { lostSend = true; }).finally(() => {
      sending = false;
      if (!stopped && pending.size > 0) timer ??= setTimeout(flush, FLUSH_MS);
    });
  };

  const record = (rel: string) => {
    if (stopped || isSkipped(rel)) return;
    pending.add(rel);
    if (pending.size > MAX_PATHS) {
      const tops = new Set([...pending].map((p) => p.split('/')[0]));
      pending = tops.size > MAX_PATHS ? new Set([WHOLE]) : tops;
    }
    timer ??= setTimeout(flush, FLUSH_MS);
  };

  const goDown = (reason: unknown) => {
    if (down) return;
    down = true;
    stop();
    console.warn('[workspace-watcher] down, open files reload only on window return:', reason);
    const why = reason instanceof Error ? reason.message : String(reason);
    send([WHOLE], why.slice(0, 200), AbortSignal.timeout(SEND_TIMEOUT_MS)).catch(() => {});
  };

  const unwatchUnder = (rel: string) => {
    for (const [dir, watcher] of watchers) {
      if (dir === rel || dir.startsWith(`${rel}/`)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
  };

  // Asynchronous, so the server keeps answering while a large workspace is walked.
  const watchTree = async (rel: string): Promise<void> => {
    if (stopped || watchers.has(rel) || (rel !== PROBE_DIR && isSkipped(rel))) return;
    if (watchers.size >= MAX_WATCHES) {
      goDown(new Error(`more than ${MAX_WATCHES} folders to watch`));
      return;
    }
    const abs = path.join(root, rel);
    try {
      const watcher = fs.watch(abs, (_event, name) => {
        // macOS can report a change with no name: something in this folder changed. Record the
        // folder, and keep its watch rather than rewatching it, which would miss events meanwhile.
        if (!name) {
          record(rel);
          return;
        }
        const child = rel ? `${rel}/${name}` : String(name);
        if (probing && child.startsWith(`${PROBE_DIR}/`)) heard.add(child);
        if (child === PROBE_DIR || child.startsWith(`${PROBE_DIR}/`)) return;
        record(child);
        if (_event !== 'rename') return;
        // Watches follow folders, not names, and a folder replaced under the same name can reuse the
        // old inode, so a rename naming a watched folder always rewatches it. The folder itself is
        // recorded above, so a write landing during the rewalk still reloads what is open under it.
        if (watchers.has(child)) unwatchUnder(child);
        // lstat, as the walk's Dirent check: a link to a folder is not followed into a skipped tree.
        fs.promises.lstat(path.join(root, child)).then(
          (stat) => { if (stat.isDirectory()) void watchTree(child); },
          () => {},
        );
      });
      watcher.on('error', goDown);
      watchers.set(rel, watcher);
      for (const entry of await fs.promises.readdir(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) await watchTree(rel ? `${rel}/${entry.name}` : entry.name);
      }
    } catch (error) {
      // A folder removed while being walked is not a broken watcher.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') goDown(error);
    }
  };

  const heardAfter = async (rel: string, act: () => void) => {
    heard.delete(rel);
    act();
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (!heard.has(rel)) {
      if (Date.now() > deadline) throw new Error(`no event for ${rel}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  try {
    const probe = path.join(root, PROBE_DIR);
    fs.rmSync(probe, { recursive: true, force: true });
    fs.mkdirSync(probe);
    await watchTree('');
    await watchTree(PROBE_DIR);
    if (down) {
      fs.rmSync(probe, { recursive: true, force: true });
      return { stop, down };
    }
    // macOS FSEvents delivers only from a moment after a watch opens; Linux needs no wait.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await heardAfter(`${PROBE_DIR}/file`, () => fs.writeFileSync(path.join(probe, 'file'), 'probe'));
    fs.mkdirSync(path.join(probe, 'dir'));
    await heardAfter(`${PROBE_DIR}/moved`, () => fs.renameSync(path.join(probe, 'dir'), path.join(probe, 'moved')));
    await heardAfter(`${PROBE_DIR}/file`, () => fs.rmSync(path.join(probe, 'file')));
    fs.rmSync(probe, { recursive: true, force: true });
    unwatchUnder(PROBE_DIR);
    probing = false;
    heard.clear();
  } catch (error) {
    fs.rmSync(path.join(root, PROBE_DIR), { recursive: true, force: true });
    goDown(error);
    return { stop, down };
  }

  record(WHOLE);
  return { stop, down };
}
