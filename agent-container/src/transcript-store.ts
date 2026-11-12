import { createRequire } from 'node:module';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

let store: SessionStore | undefined;

/**
 * Where session transcripts are kept besides the local disk. With none, they
 * live only under CLAUDE_CONFIG_DIR. With one, the SDK mirrors every transcript
 * write to it and resumes from it, so a session outlives the container's disk.
 */
export function transcriptStore(): SessionStore | undefined {
  return store;
}

export function setTranscriptStore(next: SessionStore | undefined): void {
  store = next;
}

/**
 * A deployment names its store in TRANSCRIPT_STORE_MODULE: the path of a
 * module whose default export is an SDK SessionStore. A module that cannot be
 * used throws: running without the store would lose transcripts silently.
 */
export function loadTranscriptStore(modulePath = process.env.TRANSCRIPT_STORE_MODULE): void {
  if (!modulePath) return;
  const loaded: unknown = createRequire(__filename)(modulePath);
  const candidate = isRecord(loaded) && 'default' in loaded ? loaded.default : loaded;
  if (!isSessionStore(candidate)) {
    throw new Error(`TRANSCRIPT_STORE_MODULE ${modulePath} does not export a session store (append and load)`);
  }
  store = candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSessionStore(value: unknown): value is SessionStore {
  return isRecord(value) && typeof value.append === 'function' && typeof value.load === 'function';
}
