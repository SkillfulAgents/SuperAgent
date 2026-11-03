import * as fs from 'fs'
import * as path from 'path'
import { loadHints, parseHint } from './hint-loader'
import { compileTrigger, type HintEventInput } from './hint-matchers'
import type { Hint } from './hint-schema'

/** The hook events a recorded session would have raised: tool calls (Pre and Post) and the user's prompts. */
export function eventsFromTranscript(jsonl: string): HintEventInput[] {
  const events: HintEventInput[] = []
  const seen = new Set<string>()
  for (const line of jsonl.split('\n')) {
    let entry: { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry.message?.content
    if (entry.type === 'user' && !entry.isMeta && typeof content === 'string') {
      events.push({ event: 'UserPromptSubmit', prompt: content })
      continue
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
      // Streamed sessions record the same tool_use block more than once.
      if (block.type !== 'tool_use' || !block.name || (block.id && seen.has(block.id))) continue
      if (block.id) seen.add(block.id)
      events.push({ event: 'PreToolUse', toolName: block.name, toolInput: block.input })
      events.push({ event: 'PostToolUse', toolName: block.name, toolInput: block.input })
    }
  }
  return events
}

/** Every event a hint's triggers match, ignoring `repeat` (the question is where it could fire). */
export function matchingEvents(hint: Hint, events: HintEventInput[]): HintEventInput[] {
  const triggers = hint.triggers.map(compileTrigger)
  return events.filter((event) => triggers.some((matches) => matches(event)))
}

function describe(event: HintEventInput): string {
  if (event.event === 'UserPromptSubmit') return `prompt: ${event.prompt}`
  const input = event.toolInput as Record<string, unknown> | undefined
  const detail = typeof input?.command === 'string' ? input.command : JSON.stringify(input ?? {})
  return `${event.toolName}: ${detail}`
}

function transcripts(root: string): string[] {
  if (fs.statSync(root).isFile()) return root.endsWith('.jsonl') ? [root] : []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) return transcripts(full)
    return entry.isFile() && full.endsWith('.jsonl') ? [full] : []
  })
}

/** A `<task>__<id>` directory is one run of a task, however many sessions it holds; otherwise each file is a run. */
function runOf(file: string): { run: string; group: string } {
  const parts = file.split(path.sep)
  const i = parts.findIndex((part) => /^.+__[A-Za-z0-9]+$/.test(part))
  if (i < 0) return { run: file, group: path.dirname(file) }
  return { run: parts.slice(0, i + 1).join(path.sep), group: parts[i].split('__')[0] }
}

function loadTarget(target: string): Hint[] {
  if (fs.statSync(target).isDirectory()) return loadHints(target)
  return [parseHint(path.basename(target), fs.readFileSync(target, 'utf-8'))]
}

function main(argv: string[]): void {
  const [target, ...roots] = argv
  if (!target || roots.length === 0) {
    console.error('Usage: npx ts-node src/hints/hint-fires.ts <hint.md | hints dir> <transcript dir or .jsonl>...')
    process.exit(2)
  }
  const hints = loadTarget(target)
  const runs = new Map<string, Set<string>>()
  const hits = new Map<string, Map<string, { runs: Set<string>; examples: Set<string> }>>()
  for (const file of roots.flatMap(transcripts)) {
    const { run, group } = runOf(file)
    runs.set(group, (runs.get(group) ?? new Set()).add(run))
    const events = eventsFromTranscript(fs.readFileSync(file, 'utf-8'))
    for (const hint of hints) {
      const matched = matchingEvents(hint, events)
      if (matched.length === 0) continue
      const byGroup = hits.get(hint.name) ?? new Map()
      const row = byGroup.get(group) ?? { runs: new Set<string>(), examples: new Set<string>() }
      row.runs.add(run)
      for (const event of matched) if (row.examples.size < 3) row.examples.add(describe(event).replace(/\s+/g, ' ').slice(0, 160))
      byGroup.set(group, row)
      hits.set(hint.name, byGroup)
    }
  }
  for (const hint of hints) {
    const byGroup = hits.get(hint.name)
    const total = byGroup ? [...byGroup.values()].reduce((sum, row) => sum + row.runs.size, 0) : 0
    console.log(`\n${hint.name}: fires in ${total} of ${[...runs.values()].reduce((sum, set) => sum + set.size, 0)} runs`)
    for (const [group, row] of [...(byGroup ?? new Map()).entries()].sort((a, b) => b[1].runs.size - a[1].runs.size)) {
      console.log(`  ${group}: ${row.runs.size}/${runs.get(group)?.size}`)
      for (const example of row.examples) console.log(`      ${example}`)
    }
  }
}

if (require.main === module) main(process.argv.slice(2))
