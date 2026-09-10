// Runs `vite build` only when a source file is newer than the build output.
// Container restarts re-run the start script with unchanged sources, so an
// unconditional build wastes seconds of the user's dashboard wait; mtime
// comparison keeps the rebuild automatic after any real edit.
// Set DASHBOARD_FORCE_BUILD=1 to build unconditionally.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build inputs/outputs that must not count as sources.
const EXCLUDES = new Set([
  'node_modules',
  'dist',
  'dashboard.log',
  'screenshot.png',
  'bun.lock',
  'bun.lockb',
]);
// A tree bigger than this rebuilds rather than risk an incomplete scan.
const MAX_ENTRIES = 2000;

function newestMtimeMs(dir, excludes) {
  let newest = 0;
  let seen = 0;
  const stack = [dir];
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (excludes.has(entry.name)) continue;
        if (++seen > MAX_ENTRIES) return null;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > newest) newest = mtime;
        }
      }
    }
  } catch {
    return null;
  }
  return newest;
}

const distStamp = newestMtimeMs(path.join(__dirname, 'dist'), new Set());
const sourceStamp = newestMtimeMs(__dirname, EXCLUDES);
const fresh =
  !process.env.DASHBOARD_FORCE_BUILD &&
  distStamp !== null &&
  distStamp !== 0 &&
  sourceStamp !== null &&
  sourceStamp <= distStamp;

if (fresh) {
  console.log('[build-if-needed] dist is up to date, skipping build');
} else {
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: __dirname,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
