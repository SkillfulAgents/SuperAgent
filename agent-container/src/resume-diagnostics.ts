import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { diagnosticAssistantSchema } from './resume-diagnostics-schema';

/**
 * CLI 2.1.280 treats an assistant's requestId as proof that its message.id is
 * an Anthropic ID. OpenRouter supplies request IDs too, so a resumed query
 * sends its gen-* ID as diagnostics.previous_message_id and Anthropic rejects
 * it. Remove that diagnostic hint, never the message ID, content or usage.
 * Keep malformed/unknown lines verbatim, as the SDK does when resuming.
 */
export function resetForeignDiagnostics(transcript: string): string {
  return transcript.split('\n').map(line => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return line; }
    const parsed = diagnosticAssistantSchema.safeParse(raw);
    if (!parsed.success || parsed.data.message.id.startsWith('msg_')) return line;
    const { requestId: _requestId, ...entry } = raw as Record<string, unknown>;
    return JSON.stringify(entry);
  }).join('\n');
}

/** Call only after the previous CLI has stopped, before spawning its resume. */
export function prepareResumeDiagnostics(sessionId: string, configDir = join(homedir(), '.claude')): void {
  // Session IDs come from the SDK; never allow a path supplied by a caller.
  if (!z.uuid().safeParse(sessionId).success) return;
  const projectsDir = join(configDir, 'projects');
  let projects: fs.Dirent[];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Find by UUID rather than reproducing the SDK's project-path encoding
  // (including hashed long paths). Only this session and its subagents change.
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = join(projectsDir, project.name);
    const transcript = join(directory, `${sessionId}.jsonl`);
    if (!fs.existsSync(transcript)) continue;
    resetFile(transcript);
    resetSubagents(join(directory, sessionId));
  }
}

function resetSubagents(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) resetSubagents(file);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) resetFile(file);
  }
}

function resetFile(file: string): void {
  const original = fs.readFileSync(file, 'utf8');
  const updated = resetForeignDiagnostics(original);
  if (updated === original) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
