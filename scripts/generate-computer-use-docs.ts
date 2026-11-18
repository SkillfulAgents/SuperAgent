/**
 * Generates the agent-facing computer-use guides in agent-container/docs from
 * the skills of the installed agent-desktop, so the guides describe the
 * version the app runs:
 *
 * - agent-container/docs/computer-use.md: the Gamut header, then the core skill
 * - agent-container/docs/computer-use/*.md: the core references, and the macOS
 *   and Windows guides with their references
 *
 * The skills, the command help the tools are generated from and the surfaces
 * this OS supports come from the agent-desktop binary itself. `--source github`
 * takes the skills from the repo at the matching release tag instead, for a
 * machine where the binary cannot run; that source has no command help, so it
 * leaves the tools and the flags guide as they are.
 *
 * Usage: npx tsx scripts/generate-computer-use-docs.ts [--source binary|github]
 *   (npm run docs:computer-use)
 */

import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { z } from 'zod'
import {
  CORE_SKILL,
  DROPPED_LINES,
  DROPPED_SECTIONS,
  REPLACED_TEXT,
  PLATFORM_SKILLS,
  REFUSED_COMMANDS,
  TOOL_COMMANDS,
  dropLines,
  dropSections,
  parseCommandList,
  parseToolSpec,
  readVersionStamp,
  referenceName,
  renderFlagsGuide,
  renderHeader,
  renderToolSpecs,
  rewriteSkillLinks,
  stripFrontmatter,
  versionStamp,
  withPlatformSurfaces,
  type GuideFile,
  type SkillSpec,
  type ToolSpec,
} from './lib/computer-use-docs'

const ROOT = path.resolve(__dirname, '..')
const PACKAGE_DIR = path.join(ROOT, 'node_modules', 'agent-desktop')
const DOCS_DIR = path.join(ROOT, 'agent-container', 'docs')
const MAIN_GUIDE = path.join(DOCS_DIR, 'computer-use.md')
const GUIDE_DIR = path.join(DOCS_DIR, 'computer-use')
/** The tool specs, one copy per side: the host may not import the container, nor the container the host. */
const TOOL_SPEC_FILES = [
  path.join(ROOT, 'src', 'shared', 'lib', 'computer-use', 'agent-desktop-tools.ts'),
  path.join(ROOT, 'agent-container', 'src', 'tools', 'agent-desktop-tools.ts'),
]
const REPO = 'vercel-labs/agent-desktop'

const packageJsonSchema = z.object({ version: z.string() }).passthrough()

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
}).passthrough()

const skillListSchema = z.object({
  skills: z.array(z.object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    references: z.array(z.string()).default([]),
  }).passthrough()),
})

const skillContentSchema = z.object({ content: z.string() }).passthrough()

const githubListingSchema = z.array(z.object({ name: z.string(), type: z.string() }).passthrough())

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} is not JSON: ${text.slice(0, 200)}`)
  }
}

const statusSchema = z.object({ platform: z.string(), supported_surfaces: z.array(z.string()) }).passthrough()

interface CommandHelp {
  globalHelp: string
  commands: Array<{ command: string; help: string }>
  /** The OS the binary runs on, and the surfaces it supports there (`status`). */
  status: z.infer<typeof statusSchema>
}

interface SkillSource {
  readonly name: string
  references(skill: SkillSpec): Promise<string[]>
  content(skill: SkillSpec, reference?: string): Promise<string>
  /** Every command's `--help`, or null when this source has none. */
  commandHelp(): Promise<CommandHelp | null>
}

/** The skills compiled into the installed binary. */
function binarySource(): SkillSource {
  // On Windows the package keeps only the arch-named binary (its bin entry is a .cmd launcher).
  const executable = path.join(PACKAGE_DIR, 'bin', process.platform === 'win32' ? `agent-desktop-win32-${process.arch}.exe` : 'agent-desktop')
  const home = mkdtempSync(path.join(tmpdir(), 'agent-desktop-docs-'))
  process.on('exit', () => rmSync(home, { recursive: true, force: true }))
  const exec = (args: string[]): string => execFileSync(executable, args, {
    env: { ...process.env, AGENT_DESKTOP_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const run = (args: string[]): unknown => {
    const stdout = exec(args)
    const envelope = envelopeSchema.parse(parseJson(stdout.trim().split('\n').pop() ?? '', `agent-desktop ${args.join(' ')}`))
    if (!envelope.ok) throw new Error(`agent-desktop ${args.join(' ')}: ${envelope.error?.code} ${envelope.error?.message}`)
    return envelope.data
  }
  let listing: z.infer<typeof skillListSchema> | null = null
  return {
    name: `the agent-desktop binary (${executable})`,
    async references(skill) {
      listing ??= skillListSchema.parse(run(['skills']))
      const entry = listing.skills.find((s) => s.name === skill.dir || s.aliases?.includes(skill.alias))
      if (!entry) throw new Error(`agent-desktop lists no skill ${skill.dir}`)
      return entry.references.map(referenceName)
    },
    async content(skill, reference) {
      return skillContentSchema.parse(run(['skills', 'get', skill.alias, ...(reference ? [reference] : [])])).content
    },
    async commandHelp() {
      const globalHelp = exec(['--help'])
      const commands = parseCommandList(globalHelp)
        .filter((command) => !REFUSED_COMMANDS.has(command))
        .map((command) => ({ command, help: exec([command, '-h']) }))
      return { globalHelp, commands, status: statusSchema.parse(run(['status'])) }
    },
  }
}

/** The skills in the agent-desktop repo at the installed version's release tag. */
function githubSource(version: string): SkillSource {
  const tag = `v${version}`
  const get = async (url: string): Promise<Response> => {
    const response = await fetch(url, { headers: { 'User-Agent': 'gamut-computer-use-docs' } })
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`)
    return response
  }
  return {
    name: `github.com/${REPO} at ${tag}`,
    async references(skill) {
      const url = `https://api.github.com/repos/${REPO}/contents/skills/${skill.dir}/references?ref=${tag}`
      const listing = githubListingSchema.parse(await (await get(url)).json())
      return listing.filter((item) => item.type === 'file' && item.name.endsWith('.md')).map((item) => referenceName(item.name)).sort()
    },
    async content(skill, reference) {
      const file = reference ? `references/${reference}.md` : 'SKILL.md'
      return (await get(`https://raw.githubusercontent.com/${REPO}/${tag}/skills/${skill.dir}/${file}`)).text()
    },
    // Help text comes only from a binary that runs.
    async commandHelp() {
      return null
    },
  }
}

function installedVersion(): string {
  const file = path.join(PACKAGE_DIR, 'package.json')
  return packageJsonSchema.parse(parseJson(readFileSync(file, 'utf8'), file)).version
}

/** The tool specs generated before, for the surfaces other OSes recorded; none when there are none yet. */
function previousToolSpecs(): ToolSpec[] {
  try {
    const text = readFileSync(TOOL_SPEC_FILES[0], 'utf8')
    const marker = 'AGENT_DESKTOP_TOOLS: readonly AgentDesktopToolSpec[] = '
    const start = text.indexOf(marker)
    return start === -1 ? [] : (parseJson(text.slice(start + marker.length), TOOL_SPEC_FILES[0]) as ToolSpec[])
  } catch {
    return []
  }
}

function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback
}

function finish(markdown: string, version: string): string {
  return `${versionStamp(version)}\n${markdown.trim()}\n`
}

async function generate(source: SkillSource, version: string): Promise<void> {
  const coreReferences = await source.references(CORE_SKILL)
  const help = await source.commandHelp()
  // A guide's path under the docs root picks the sections it leaves out.
  const rewrite = (markdown: string, skill: SkillSpec, file: string) => REPLACED_TEXT.reduce(
    (text, [from, to]) => text.split(from).join(to),
    dropLines(
      dropSections(rewriteSkillLinks(stripFrontmatter(markdown), skill, coreReferences), DROPPED_SECTIONS[file] ?? []),
      DROPPED_LINES,
    ),
  )
  const files: Array<GuideFile & { body: string }> = []

  for (const reference of coreReferences) {
    const file = `computer-use/${reference}.md`
    const body = rewrite(await source.content(CORE_SKILL, reference), CORE_SKILL, file)
    files.push({ path: file, title: titleOf(body, reference), body })
  }
  for (const platform of PLATFORM_SKILLS) {
    const body = rewrite(await source.content(platform), platform, platform.file!)
    files.push({ path: platform.file!, title: titleOf(body, platform.alias), body })
    for (const reference of await source.references(platform)) {
      const file = `computer-use/${platform.prefix}${reference}.md`
      const refBody = rewrite(await source.content(platform, reference), platform, file)
      files.push({ path: file, title: titleOf(refBody, reference), body: refBody })
    }
  }
  const core = rewrite(await source.content(CORE_SKILL), CORE_SKILL, 'computer-use.md')
  if (help) {
    // Stamped by renderFlagsGuide itself; finish() would stamp it twice.
    files.push({ path: 'computer-use/flags.md', title: 'Command Flags', body: renderFlagsGuide(version, help.globalHelp, help.commands) })
    const specs = TOOL_COMMANDS.map((command) => {
      const entry = help.commands.find((c) => c.command === command)
      if (!entry) throw new Error(`agent-desktop ${version} has no ${command} command for its tool`)
      return parseToolSpec(command, entry.help)
    })
    // The help is the same on every OS; the surfaces each takes are not. This
    // binary can only say which its own OS takes: the others' are kept.
    const narrowed = withPlatformSurfaces(specs, help.status.platform, help.status.supported_surfaces, previousToolSpecs())
    for (const file of TOOL_SPEC_FILES) writeFileSync(file, renderToolSpecs(version, narrowed))
  } else {
    console.warn('No new flags guide or tools: this source has no command help. Regenerate from the binary before merging.')
  }

  // The directory holds only generated guides: clear it so a reference that
  // left upstream leaves here too (the flags guide stays when this source
  // cannot write one).
  const flagsGuide = path.join(GUIDE_DIR, 'flags.md')
  const keptFlags = help ? null : readFileSync(flagsGuide, 'utf8')
  rmSync(GUIDE_DIR, { recursive: true, force: true })
  mkdirSync(GUIDE_DIR, { recursive: true })
  if (keptFlags !== null) writeFileSync(flagsGuide, keptFlags)
  for (const file of files) {
    const text = readVersionStamp(file.body) ? `${file.body.trim()}\n` : finish(file.body, version)
    writeFileSync(path.join(DOCS_DIR, file.path), text)
  }
  writeFileSync(MAIN_GUIDE, `${renderHeader(version, files)}${core.trim()}\n`)

  console.log(`Wrote ${files.length + 1} guides for agent-desktop ${version} from ${source.name}:`)
  console.log(`  ${path.relative(ROOT, MAIN_GUIDE)}`)
  for (const name of readdirSync(GUIDE_DIR).sort()) console.log(`  ${path.relative(ROOT, path.join(GUIDE_DIR, name))}`)
}

async function main(): Promise<void> {
  const sourceArg = process.argv.indexOf('--source')
  const wanted = sourceArg === -1 ? 'binary' : process.argv[sourceArg + 1]
  if (!['binary', 'github'].includes(wanted)) throw new Error('--source takes binary or github')

  const version = installedVersion()
  let previous: string | null = null
  try {
    previous = readVersionStamp(readFileSync(MAIN_GUIDE, 'utf8'))
  } catch {
    // No guide yet.
  }
  if (previous && previous !== version) console.log(`Regenerating for agent-desktop ${previous} → ${version}`)

  await generate(wanted === 'github' ? githubSource(version) : binarySource(), version)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
