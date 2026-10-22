import * as fs from 'fs'
import * as path from 'path'
import yaml from 'js-yaml'
import { hintFrontmatterSchema, type Hint } from './hint-schema'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseHint(fileName: string, text: string): Hint {
  const parts = FRONTMATTER.exec(text)
  if (!parts) throw new Error(`Hint ${fileName} has no frontmatter`)
  const meta = hintFrontmatterSchema.parse(yaml.load(parts[1]))
  if (`${meta.name}.md` !== fileName) throw new Error(`Hint ${fileName} must be named "${meta.name}.md"`)
  const content = parts[2].trim()
  if (!content) throw new Error(`Hint ${fileName} has an empty body`)
  return { ...meta, content }
}

/** Reads `<dir>/<topic>/<name>.md`. The topic folder only groups files. */
export function loadHints(dir: string): Hint[] {
  const hints: Hint[] = []
  for (const topic of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!topic.isDirectory()) continue
    for (const file of fs.readdirSync(path.join(dir, topic.name))) {
      if (!file.endsWith('.md')) continue
      hints.push(parseHint(file, fs.readFileSync(path.join(dir, topic.name, file), 'utf-8')))
    }
  }
  const seen = new Set<string>()
  for (const hint of hints) {
    if (seen.has(hint.name)) throw new Error(`Duplicate hint name "${hint.name}"`)
    seen.add(hint.name)
  }
  return hints.sort((a, b) => a.name.localeCompare(b.name))
}
