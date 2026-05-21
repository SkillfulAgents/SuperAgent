const TTL_MS = 5000;

type ExecBrowser = (args: string[], cdpUrl?: string) => Promise<{ stdout: string; exitCode: number }>;

interface CacheEntry {
  text: string;
  capturedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface SnapshotOptions {
  mode?: 'navigation' | 'detailed' | null;
  scope?: string | null;
  json?: boolean;
  interactive?: boolean;
  compact?: boolean;
}

export type SnapshotResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function invalidate(sessionId: string): void {
  cache.delete(sessionId);
}

function truncateToDepth(text: string, depth: number): string {
  const maxLeadingSpaces = depth * 2;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) {
      out.push(line);
      continue;
    }
    const lead = line.length - trimmed.length;
    if (lead <= maxLeadingSpaces) out.push(line);
  }
  return out.join('\n');
}

// Scope is intentionally simple: a CSS selector or XPath. The model should
// choose the selector it actually wants to query; we do not guess accessible
// names or interpret snapshot refs as scope targets.
export function buildScopeCandidates(scope: string): string[] {
  return [scope];
}

const NAVIGATE_DEPTH = 1;

export async function takeSnapshot(
  sessionId: string,
  opts: SnapshotOptions,
  cdpUrl: string | null,
  execBrowser: ExecBrowser
): Promise<SnapshotResult> {
  const mode = opts.mode === 'detailed' ? 'detailed' : 'navigation';
  const hasScope = typeof opts.scope === 'string' && opts.scope.length > 0;
  if (mode === 'detailed' && !hasScope) {
    return {
      ok: false,
      error: 'mode "detailed" requires scope. First use the default navigation snapshot to identify a CSS/XPath selector, then retry with mode "detailed" and scope.',
    };
  }
  const canUseCache =
    mode === 'navigation' &&
    !hasScope &&
    !opts.json &&
    opts.interactive !== false &&
    opts.compact !== false;

  if (canUseCache) {
    const cached = cache.get(sessionId);
    const fresh = cached && Date.now() - cached.capturedAt <= TTL_MS;
    let full = fresh ? cached!.text : null;
    if (full == null) {
      const res = await execBrowser(['snapshot', '-i', '-c'], cdpUrl ?? undefined);
      if (res.exitCode !== 0) return { ok: false, error: res.stdout };
      full = res.stdout;
      cache.set(sessionId, { text: full, capturedAt: Date.now() });
    }
    return { ok: true, text: truncateToDepth(full, NAVIGATE_DEPTH) };
  }

  const snapshotOptions = ['-c'];
  if (opts.json) snapshotOptions.push('--json');
  if (opts.interactive !== false) snapshotOptions.push('-i');
  if (opts.compact === false) snapshotOptions.splice(snapshotOptions.indexOf('-c'), 1);

  const selectors = hasScope ? buildScopeCandidates(opts.scope!) : [null];
  let last = { stdout: '', exitCode: 0 };
  for (const sel of selectors) {
    const args = sel ? ['snapshot', ...snapshotOptions, '-s', sel] : ['snapshot', ...snapshotOptions];
    last = await execBrowser(args, cdpUrl ?? undefined);
    if (last.exitCode === 0) {
      if (mode === 'detailed' || opts.json) return { ok: true, text: last.stdout };
      return { ok: true, text: truncateToDepth(last.stdout, NAVIGATE_DEPTH) };
    }
  }
  return { ok: false, error: last.stdout };
}

export const __test = { truncateToDepth };
