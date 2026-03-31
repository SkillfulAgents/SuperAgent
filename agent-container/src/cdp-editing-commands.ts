// CDP keyboard shortcut support via Playwright's macEditingCommands map.
// Chrome's CDP Input.dispatchKeyEvent needs a `commands` array to trigger
// editing actions (selectAll, cut, undo, etc.) on all platforms.

import * as path from 'path';

/**
 * Resolve the absolute path to playwright-core's macEditingCommands module.
 * playwright-core's package.json `exports` field blocks subpath requires,
 * so we find the package root first, then construct the full path.
 */
function resolveMacEditingCommandsPath(): string | null {
  // Strategy 1: find playwright-core via normal Node resolution, then build the subpath.
  // require.resolve('playwright-core') gives us the main entry; we derive the package root.
  try {
    const mainEntry = require.resolve('playwright-core');
    // mainEntry is something like .../playwright-core/lib/... or .../playwright-core/index.js
    const pkgRoot = mainEntry.replace(/([\\/]playwright-core[\\/]).*$/, '$1');
    return path.join(pkgRoot, 'lib', 'server', 'macEditingCommands');
  } catch {
    // playwright-core not in local node_modules
  }

  // Strategy 2: hardcoded container path (globally-installed agent-browser)
  const containerPath = '/usr/lib/node_modules/agent-browser/node_modules/playwright-core/lib/server/macEditingCommands';
  try {
    require.resolve(containerPath);
    return containerPath;
  } catch {
    // Not in container environment
  }

  return null;
}

/**
 * Load Playwright's macEditingCommands map, trying multiple resolution strategies
 * so we don't break if the package is hoisted or the container layout changes.
 */
function loadMacEditingCommands(): Record<string, string | string[]> {
  const resolvedPath = resolveMacEditingCommandsPath();
  if (resolvedPath) {
    try {
      const mod = require(resolvedPath);
      const map = mod.macEditingCommands;
      if (map && typeof map === 'object' && Object.keys(map).length > 0) {
        return map;
      }
    } catch {
      // Fall through to warning
    }
  }

  console.warn(
    '[Browser] Could not load macEditingCommands from playwright-core — ' +
    'keyboard shortcuts in browser preview may not work'
  );
  return {};
}

export const macEditingCommands = loadMacEditingCommands();

/**
 * Look up CDP editing commands for a key combo.
 * Matches Playwright's crInput._commandsForCode() — modifier order is
 * Shift, Control, Alt, Meta (same order Playwright iterates).
 *
 * @param code  - The KeyboardEvent.code (e.g. "KeyA", "Backspace")
 * @param modifiers - CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
 */
export function getEditingCommands(code: string, modifiers: number): string[] {
  const parts: string[] = [];
  if (modifiers & 8) parts.push('Shift');
  if (modifiers & 2) parts.push('Control');
  if (modifiers & 1) parts.push('Alt');
  if (modifiers & 4) parts.push('Meta');
  parts.push(code);
  const shortcut = parts.join('+');
  let cmds = macEditingCommands[shortcut];
  if (!cmds) return [];
  if (typeof cmds === 'string') cmds = [cmds];
  return cmds
    .filter((c: string) => !c.startsWith('insert'))
    .map((c: string) => c.endsWith(':') ? c.slice(0, -1) : c);
}
