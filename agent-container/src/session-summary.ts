import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────

/** Number of turns between summary regenerations (first turn always generates) */
const SUMMARY_TURN_INTERVAL = 10;

/** Model to use for summary generation */
const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

/** Max characters of conversation to include in the summary prompt */
const SUMMARY_MAX_CONTEXT_CHARS = 8000;

/** Delay between backfill calls (ms) to avoid API hammering */
const BACKFILL_DELAY_MS = 500;

/** Delay before starting backfill on container startup (ms) */
export const BACKFILL_STARTUP_DELAY_MS = 10_000;

// ─── Paths ──────────────────────────────────────────────────────────────────

const SESSIONS_DIR = '/workspace/.claude/projects/-workspace';
const SESSION_METADATA_PATH = '/workspace/session-metadata.json';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a summary on turn 1, then every SUMMARY_TURN_INTERVAL turns */
export function shouldGenerateSummary(turnCount: number): boolean {
  return turnCount === 1 || turnCount % SUMMARY_TURN_INTERVAL === 0;
}

interface SessionMetadataEntry {
  name?: string;
  summary?: string;
  summaryGeneratedAt?: string;
  [key: string]: unknown;
}

function readMetadataFile(): Record<string, SessionMetadataEntry> {
  try {
    if (fs.existsSync(SESSION_METADATA_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_METADATA_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[SessionSummary] Failed to read session-metadata.json:', err);
  }
  return {};
}

/**
 * Extract readable conversation text from a JSONL file.
 * Returns user and assistant messages, truncated to SUMMARY_MAX_CONTEXT_CHARS.
 */
function extractConversationText(jsonlPath: string): { text: string; messageCount: number } {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  const messages: string[] = [];
  let messageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.type === 'user' && entry.message?.content) {
        const text = extractTextContent(entry.message.content);
        if (text) {
          messages.push(`User: ${text}`);
          messageCount++;
        }
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = extractTextContent(entry.message.content);
        if (text) {
          messages.push(`Assistant: ${text}`);
          messageCount++;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Truncate from the end to fit within max chars
  let combined = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i] + '\n\n' + combined;
    if (candidate.length > SUMMARY_MAX_CONTEXT_CHARS) break;
    combined = candidate;
  }

  return { text: combined.trim(), messageCount };
}

/**
 * Extract plain text from message content (handles both string and content block array formats).
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text' && block.text)
      .map((block: any) => block.text)
      .join('\n');
  }
  return '';
}

// ─── Anthropic Client (lazy singleton) ──────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Generate a summary for a session by reading its JSONL and calling Haiku.
 * Returns the summary string, or null if generation should be skipped or fails.
 */
export async function generateSessionSummary(sessionId: string): Promise<string | null> {
  const client = getAnthropicClient();
  if (!client) {
    console.warn('[SessionSummary] No ANTHROPIC_API_KEY, skipping summary generation');
    return null;
  }

  const jsonlPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    return null;
  }

  const { text, messageCount } = extractConversationText(jsonlPath);

  // Skip very short sessions
  if (messageCount < 2 || !text) {
    return null;
  }

  try {
    const response = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation in 2-4 sentences. Focus on: what the user asked for, what was accomplished, and any key decisions or outcomes. Be specific about technologies, files, or topics discussed.\n\n<conversation>\n${text}\n</conversation>`,
        },
      ],
    });

    const summary = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');

    return summary || null;
  } catch (err) {
    console.error(`[SessionSummary] Haiku API call failed for session ${sessionId}:`, err);
    return null;
  }
}

/**
 * Write a summary to session-metadata.json atomically.
 */
export async function writeSessionSummary(sessionId: string, summary: string): Promise<void> {
  const metadata = readMetadataFile();

  if (!metadata[sessionId]) {
    metadata[sessionId] = {};
  }

  metadata[sessionId].summary = summary;
  metadata[sessionId].summaryGeneratedAt = new Date().toISOString();

  const tmpPath = SESSION_METADATA_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2));
  fs.renameSync(tmpPath, SESSION_METADATA_PATH);

  console.log(`[SessionSummary] Summary written for session ${sessionId}`);
}

/**
 * Backfill summaries for all sessions that are missing one.
 */
export async function backfillMissingSummaries(): Promise<void> {
  console.log('[SessionSummary] Starting backfill of missing summaries...');

  if (!getAnthropicClient()) {
    console.warn('[SessionSummary] No ANTHROPIC_API_KEY, skipping backfill');
    return;
  }

  let jsonlFiles: string[];
  try {
    jsonlFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    console.log('[SessionSummary] No sessions directory found, skipping backfill');
    return;
  }

  let generated = 0;
  for (const file of jsonlFiles) {
    const sessionId = path.basename(file, '.jsonl');

    // Re-read metadata each iteration to see writes from previous iterations
    // and avoid clobbering concurrent webapp writes
    const metadata = readMetadataFile();

    // Skip if already has a summary
    if (metadata[sessionId]?.summary) continue;

    try {
      const summary = await generateSessionSummary(sessionId);
      if (summary) {
        await writeSessionSummary(sessionId, summary);
        generated++;
      }
    } catch (err) {
      console.error(`[SessionSummary] Backfill failed for ${sessionId}:`, err);
    }

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_DELAY_MS));
  }

  console.log(`[SessionSummary] Backfill complete: ${generated} summaries generated`);
}
