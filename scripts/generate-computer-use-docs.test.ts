import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  CORE_SKILL,
  PLATFORM_SKILLS,
  TOOL_COMMANDS,
  dropLines,
  dropSections,
  filterHelp,
  parseCommandList,
  parseToolSpec,
  readVersionStamp,
  renderFlagsGuide,
  rewriteSkillLinks,
  stripFrontmatter,
  versionStamp,
  withPlatformSurfaces,
} from './lib/computer-use-docs'

const ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'agent-container', 'docs')

function pinnedVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
  return pkg.devDependencies['agent-desktop']
}

describe('generated computer-use guides', () => {
  it('pins agent-desktop to an exact version, so the guides describe the binary that ships', () => {
    expect(pinnedVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('were generated from the agent-desktop version package.json pins (run `npm run docs:computer-use` after a bump)', () => {
    const version = pinnedVersion()
    const guides = [
      path.join(DOCS_DIR, 'computer-use.md'),
      ...readdirSync(path.join(DOCS_DIR, 'computer-use')).map((name) => path.join(DOCS_DIR, 'computer-use', name)),
    ]
    expect(guides.length).toBeGreaterThan(1)
    for (const guide of guides) {
      expect({ guide: path.relative(ROOT, guide), version: readVersionStamp(readFileSync(guide, 'utf8')) })
        .toEqual({ guide: path.relative(ROOT, guide), version })
    }
  })

  it('leave the OS permissions to the app, which checks them before a call runs and asks the user', () => {
    const guides = [
      path.join(DOCS_DIR, 'computer-use.md'),
      ...readdirSync(path.join(DOCS_DIR, 'computer-use')).map((name) => path.join(DOCS_DIR, 'computer-use', name)),
    ].filter((guide) => !path.basename(guide).startsWith('windows-'))
    for (const guide of guides) {
      const text = readFileSync(guide, 'utf8')
      for (const advice of [/agent-desktop permissions/, /permissions --(guide|request)/, /Screen Recording/, /Accessibility permission/, /First contact/, /`PERM_DENIED` \|/]) {
        expect({ guide: path.relative(ROOT, guide), advice: advice.test(text) ? String(advice) : null })
          .toEqual({ guide: path.relative(ROOT, guide), advice: null })
      }
    }
  })
})

describe('rewriteSkillLinks', () => {
  const core = ['commands-observation', 'commands-system']
  const macos = PLATFORM_SKILLS.find((skill) => skill.alias === 'macos')!

  it('turns skill loading into reading the installed guides', () => {
    const out = rewriteSkillLinks(
      'Run `agent-desktop skills get platform`. Load one: `agent-desktop skills get desktop <reference>`. '
      + 'See `agent-desktop skills get desktop workflows` and `agent-desktop skills get desktop`.',
      CORE_SKILL,
      core,
    )
    expect(out).toBe(
      'Read `/opt/gamut/docs/computer-use/macos.md` or `/opt/gamut/docs/computer-use/windows.md`. '
      + 'Load one: `/opt/gamut/docs/computer-use/<reference>.md`. '
      + 'See `/opt/gamut/docs/computer-use/workflows.md` and `/opt/gamut/docs/computer-use.md`.',
    )
  })

  it("points a platform skill's references at its prefixed files, and core reference names at theirs", () => {
    const out = rewriteSkillLinks(
      'See [references/troubleshooting.md](references/troubleshooting.md) and the `commands-system.md` reference.',
      macos,
      core,
    )
    expect(out).toBe(
      'See [/opt/gamut/docs/computer-use/macos-troubleshooting.md](/opt/gamut/docs/computer-use/macos-troubleshooting.md) '
      + 'and the `/opt/gamut/docs/computer-use/commands-system.md` reference.',
    )
  })

  it('leaves --help as the guide says it, since agents can run it', () => {
    const text = 'Run `agent-desktop <command> --help` for flags.'
    expect(rewriteSkillLinks(text, CORE_SKILL, core)).toBe(text)
  })
})

describe('generated tools', () => {
  const help = [
    'Insert text into a text target',
    '',
    'Usage: agent-desktop type [OPTIONS] <REF> <TEXT>',
    '',
    'Arguments:',
    '  <REF>   Qualified ref from snapshot (@<snapshot_id>:eN)',
    '  <TEXT>  Text to type',
    '',
    'Options:',
    '      --timeout-ms <TIMEOUT_MS>        Maximum wait in milliseconds',
    '  -v, --verbose                        Enable debug logging to stderr',
    '      --session <SESSION>              Select the snapshot namespace',
    '      --headed                         Prefer physical delivery',
    '  -w, --wait-for <WAIT_FOR>            Poll until an element matching the role:text selector appears, then return the snapshot (snapshot and ref actions only)',
    '      --wait-timeout <WAIT_TIMEOUT>    Maximum wait time in milliseconds for --wait-for / --wait-for-gone (default: 30000)',
    '      --state <TOKEN[=BOOL]>           Filter by state token (repeatable); append =true or =false',
    '      --surface <SURFACE>              Surface [default: window] [possible values: window, menu]',
    '  -h, --help                           Print help',
  ].join('\n')

  it('turns a command\'s help into its tool: arguments, then flags, in agent-desktop\'s words', () => {
    const spec = parseToolSpec('type', help)

    expect(spec).toMatchObject({ command: 'type', tool: 'computer_type', description: 'Insert text into a text target' })
    expect(spec.arguments).toEqual([
      { name: 'ref', required: true, description: 'Qualified ref from snapshot (@<snapshot_id>:eN)' },
      { name: 'text', required: true, description: 'Text to type' },
    ])
    expect(spec.options.map((option) => [option.name, option.kind])).toEqual([
      ['timeout_ms', 'value'], ['headed', 'switch'], ['wait_for', 'value'], ['wait_timeout', 'value'], ['state', 'list'], ['surface', 'value'],
    ])
    expect(spec.options.find((option) => option.name === 'surface')).toMatchObject({ values: ['window', 'menu'], description: 'Surface [default: window]' })
  })

  it('gives the wait flags only to snapshot and ref actions, as their help says', () => {
    const noRef = help.replace('[OPTIONS] <REF> <TEXT>', '[OPTIONS] <TEXT>').replace(/ {2}<REF>.*\n/, '')
    expect(parseToolSpec('clipboard-set', noRef).options.map((option) => option.name)).not.toContain('wait_for')
    expect(parseToolSpec('clipboard-set', noRef).options.map((option) => option.name)).not.toContain('wait_timeout')
  })

  it('marks a flag the usage line requires, and an argument it brackets as optional', () => {
    const spec = parseToolSpec('mouse-click', 'Click\n\nUsage: agent-desktop mouse-click [OPTIONS] --xy <XY> [MS]\n\nOptions:\n      --xy <XY>  Absolute coordinates\n')
    expect(spec.options[0]).toMatchObject({ name: 'xy', required: true })
    expect(spec.arguments[0]).toMatchObject({ name: 'ms', required: false })
  })

  it('leaves out what the app refuses', () => {
    const launch = parseToolSpec('launch', 'Launch\n\nUsage: agent-desktop launch [OPTIONS] <APP>\n\nOptions:\n      --arg <ARGS>  Argument\n      --cdp [<PORT>]  DevTools\n      --activate  Bring forward\n')
    expect(launch.options.map((option) => option.name)).toEqual(['activate'])
    const screenshot = parseToolSpec('screenshot', 'Take\n\nUsage: agent-desktop screenshot [OPTIONS] [PATH]\n\nOptions:\n      --app <APP>  App\n')
    expect(screenshot.arguments).toEqual([])
  })

  it("narrows each surface flag, for the binary's OS, to the surfaces its status names", () => {
    const spec = parseToolSpec('snapshot', help.replace('[possible values: window, menu]', '[possible values: window, menu, toolbar]'))
    const [narrowed] = withPlatformSurfaces([spec], 'macos', ['window', 'menu', 'dock'])
    expect(narrowed.options.find((option) => option.name === 'surface')).toMatchObject({
      values: ['window', 'menu', 'toolbar'],
      platformValues: { macos: ['window', 'menu'] },
    })
    // Nothing to narrow when the OS takes every value.
    expect(withPlatformSurfaces([spec], 'windows', ['window', 'menu', 'toolbar', 'taskbar'])[0]).toEqual(spec)
  })

  // A binary only knows its own OS: regenerating on Windows must not drop the
  // macOS narrowing a Mac recorded, nor the other way round.
  it("keeps the other OSes' narrowing from the specs generated before", () => {
    const spec = parseToolSpec('snapshot', help.replace('[possible values: window, menu]', '[possible values: window, menu, toolbar]'))
    const [onMac] = withPlatformSurfaces([spec], 'macos', ['window', 'menu'])
    const [onWindows] = withPlatformSurfaces([spec], 'windows', ['window', 'toolbar'], [onMac])
    expect(onWindows.options.find((option) => option.name === 'surface')?.platformValues).toEqual({
      macos: ['window', 'menu'],
      windows: ['window', 'toolbar'],
    })
    // Its own OS is replaced, not merged: a surface it no longer lists goes.
    const [again] = withPlatformSurfaces([spec], 'macos', ['window', 'menu', 'toolbar'], [onWindows])
    expect(again.options.find((option) => option.name === 'surface')?.platformValues).toEqual({ windows: ['window', 'toolbar'] })
  })

  it('writes the same spec file into the host and the container', () => {
    const host = readFileSync(path.join(ROOT, 'src', 'shared', 'lib', 'computer-use', 'agent-desktop-tools.ts'), 'utf8')
    const container = readFileSync(path.join(ROOT, 'agent-container', 'src', 'tools', 'agent-desktop-tools.ts'), 'utf8')
    expect(container).toBe(host)
    expect(host).toContain(`from agent-desktop ${pinnedVersion()};`)
    for (const command of TOOL_COMMANDS) expect(host).toContain(`"command": "${command}"`)
  })
})

describe('guide helpers', () => {
  it('drops lines, and numbers the ordered list that lost one again', () => {
    const markdown = '**Fix.**\n1. Check permissions first.\n2. Remove `-i`.\n   Raise the depth.\n3. Retry.\n\n1. Other list.\n- `permissions` returns its states.\n- `version` returns it.'
    expect(dropLines(markdown, [/^\d+\. Check permissions/, /^- `permissions`/]))
      .toBe('**Fix.**\n1. Remove `-i`.\n   Raise the depth.\n2. Retry.\n\n1. Other list.\n- `version` returns it.')
  })

  it('drops whole sections by title, up to the next heading of their level', () => {
    const markdown = '# Tool\n\nIntro\n\n## Shell syntax\n\nQuote refs.\n\n### PowerShell\n\nMore.\n\n## The loop\n\nSnapshot first.\n'
    expect(dropSections(markdown, ['Shell syntax'])).toBe('# Tool\n\nIntro\n\n## The loop\n\nSnapshot first.\n')
  })

  it("lists every command's own flags, without the ones every command takes or the app refuses", () => {
    const globalHelp = 'Usage: agent-desktop [OPTIONS] [COMMAND]\n\nOptions:\n      --headed  Physical input\n  -w, --wait-for <WAIT_FOR>  Poll\n  -h, --help  Print help\n'
    const guide = renderFlagsGuide('1.2.3', globalHelp, [
      { command: 'launch', help: 'Launch\n\nUsage: agent-desktop launch [OPTIONS] <APP>\n\nOptions:\n      --activate  Bring forward\n      --cdp [<PORT>]  DevTools\n      --headed  Physical input\n' },
    ])
    const launch = guide.slice(guide.indexOf('## launch'))
    expect(launch).toContain('--activate')
    expect(launch).not.toContain('--cdp')
    expect(launch).not.toContain('--headed')
    // Listed once, for every command.
    expect(guide.slice(0, guide.indexOf('## launch'))).toContain('--headed')
  })

  it('reads back the version it stamped', () => {
    expect(readVersionStamp(`${versionStamp('1.2.3')}\n# Title`)).toBe('1.2.3')
    expect(readVersionStamp('# Hand-written')).toBeNull()
  })

  it('strips YAML frontmatter', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\n# Body\n')).toBe('# Body\n')
    expect(stripFrontmatter('# Body\n')).toBe('# Body\n')
  })

  it('lists the commands in the top-level help', () => {
    const help = 'Usage: agent-desktop [OPTIONS] [COMMAND]\n\nCommands:\n  snapshot    Capture\n  set-value   Set\n  help        Print\n\nOptions:\n  -h, --help  Print help\n'
    expect(parseCommandList(help)).toEqual(['snapshot', 'set-value', 'help'])
  })

  it('drops the flags the app sets itself from a command help, and keeps --headed, which agents pass', () => {
    const help = [
      'Options:',
      '      --app <APP>        Target app',
      '      --session <SESSION>  Select the snapshot namespace',
      '      --headed           Prefer physical delivery',
      '      --trace-strict     Fail on trace errors',
      '  -v, --verbose          Debug logging',
      '  -w, --wait-for <WAIT_FOR>  Poll until',
      '  -h, --help             Print help',
    ].join('\n')
    expect(filterHelp(help)).toBe('Options:\n      --app <APP>        Target app\n      --headed           Prefer physical delivery\n  -w, --wait-for <WAIT_FOR>  Poll until')
  })
})
