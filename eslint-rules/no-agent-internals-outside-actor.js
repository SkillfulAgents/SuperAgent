/**
 * Fence the agent internals behind the agent actor.
 *
 * Per-agent state and storage belong to the actor. That covers the container
 * manager, the message persister, the user-input, review, computer-use and
 * MCP re-auth registries, the session service and its transcript-append,
 * summary-cache and media modules, the connection runtime sync, and the
 * workflow tree. Code outside the container layer and the actor package must
 * reach them through `agentRegistry.get(slug)` from `@shared/lib/agent-actor`,
 * never by import.
 *
 * A few otherwise-open modules have fenced named exports for the same reason:
 * the agent path helpers (`getAgentWorkspaceDir`, `getAgentDir`,
 * `getSessionJsonlPath`, ...) in `file-storage` and `data-dir`, and the usage
 * loaders (`loadDailyUsageData`, `loadSessionUsageTotals`) in `usage-service`.
 * The actor's `files.workspacePath()` and friends are the sanctioned way to
 * learn where an agent's data lives. A namespace or default import of such a
 * module, or an `export *` from it, can reach every fenced name and is
 * reported under the `#*` key.
 *
 * Existing offenders are listed in `agent-internals-allowlist.json` as
 * `{ "<repo-relative file>": ["<import key>"] }`. The list only shrinks: an
 * import that is not listed is an error, and a listed import that no longer
 * exists in the file is also an error, so entries are removed as consumers are
 * ported. (A file that is deleted outright is never linted, so its stale
 * entries must be removed by hand.)
 *
 * Type-only imports are not fenced; they carry no runtime coupling. Test files
 * and `e2e/` are exempted in `.eslintrc.json` because they mock these paths.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const ALLOWLIST_PATH = path.join(__dirname, 'agent-internals-allowlist.json')

// Whole modules that only the actor may import.
const FENCED_MODULES = new Set([
  'src/shared/lib/container/container-manager',
  'src/shared/lib/container/message-persister',
  'src/shared/lib/container/connection-runtime-sync',
  'src/shared/lib/user-input/request-manager',
  'src/shared/lib/proxy/review-manager',
  'src/shared/lib/computer-use/permission-manager',
  'src/shared/lib/proxy/mcp-reauth-manager',
  'src/shared/lib/services/session-service',
  'src/shared/lib/services/session-transcript-append',
  'src/shared/lib/services/session-summary-cache',
  'src/shared/lib/services/session-media',
  'src/shared/lib/workflows/workflow-tree',
])

// Named exports fenced from modules that are otherwise open.
const FENCED_EXPORTS = new Map([
  ['src/shared/lib/config/data-dir', new Set(['getAgentWorkspaceDir', 'getAgentDownloadsDir'])],
  [
    'src/shared/lib/utils/file-storage',
    new Set([
      'getAgentWorkspaceDir',
      'getSessionJsonlPath',
      'getAgentSessionsDir',
      'getAgentDir',
      'getAgentsDir',
      'getAgentClaudeConfigDir',
      'getAgentSessionMetadataPath',
      'getAgentClaudeMdPath',
      'getAgentEnvPath',
      'getAgentPreferencesPath',
    ]),
  ],
  ['src/shared/lib/services/usage-service', new Set(['loadDailyUsageData', 'loadSessionUsageTotals'])],
])

// The actor package and the container layer it wraps may import freely, and so
// may the fenced modules themselves (they call each other).
const INTERNAL_PREFIXES = ['src/shared/lib/container/', 'src/shared/lib/agent-actor/']
const INTERNAL_FILES = new Set([...FENCED_MODULES].map((m) => `${m}.ts`))

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function stripModuleSuffix(p) {
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '').replace(/\/index$/, '')
}

/** Repo-relative, extension-less module path for an import specifier, or null for packages. */
function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith('@shared/')) return stripModuleSuffix(`src/shared/${specifier.slice('@shared/'.length)}`)
  if (specifier.startsWith('@/')) return stripModuleSuffix(`src/${specifier.slice(2)}`)
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const abs = path.resolve(path.dirname(path.join(REPO_ROOT, fromFile)), specifier)
    return stripModuleSuffix(toPosix(path.relative(REPO_ROOT, abs)))
  }
  return null
}

/** The key used in messages and in the allowlist: the `@shared/...` alias form. */
function aliasOf(modulePath) {
  return modulePath.startsWith('src/shared/') ? `@shared/${modulePath.slice('src/shared/'.length)}` : modulePath
}

/** The source-module name of an import/export specifier (Identifier or string literal). */
function specifierName(node) {
  return node.type === 'Identifier' ? node.name : node.value
}

function loadAllowlist() {
  const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${ALLOWLIST_PATH} must be an object of { file: [importKey] }`)
  }
  return parsed
}

const allowlist = loadAllowlist()

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Agent internals (container manager, message persister, input/review/permission registries, session storage and transcript modules, agent path helpers, usage loaders) may only be imported by the actor package; everything else goes through agentRegistry.get(slug)',
    },
    schema: [],
    messages: {
      fenced:
        "Agent-internal import '{{key}}': go through agentRegistry.get(slug) from '@shared/lib/agent-actor' instead. The allowlist in eslint-rules/agent-internals-allowlist.json only shrinks.",
      fencedNamespace:
        "Namespace import of '{{module}}' can reach its fenced exports; import the names you need instead. The allowlist in eslint-rules/agent-internals-allowlist.json only shrinks.",
      stale:
        "Stale allowlist entry '{{key}}' for this file in eslint-rules/agent-internals-allowlist.json: the import is gone, remove the entry.",
    },
  },

  create(context) {
    const absFilename = context.filename || context.getFilename()
    const filename = toPosix(path.relative(REPO_ROOT, absFilename))

    const allowed = new Set(allowlist[filename] || [])
    const seen = new Set()

    const isInternal =
      INTERNAL_PREFIXES.some((prefix) => filename.startsWith(prefix)) || INTERNAL_FILES.has(filename)

    function check(node, key, messageId = 'fenced') {
      if (isInternal) return
      if (allowed.has(key)) {
        seen.add(key)
        return
      }
      context.report({ node, messageId, data: { key, module: key.replace(/#\*$/, '') } })
    }

    /** Whole-module fence for any source node; true when the module is fenced outright. */
    function checkModuleSource(node, sourceNode) {
      if (!sourceNode || typeof sourceNode.value !== 'string') return false
      const resolved = resolveSpecifier(sourceNode.value, filename)
      if (!resolved || !FENCED_MODULES.has(resolved)) return false
      check(node, aliasOf(resolved))
      return true
    }

    /** Fenced named exports of an otherwise-open module, or null. */
    function fencedExportsOf(sourceNode) {
      if (!sourceNode || typeof sourceNode.value !== 'string') return null
      const resolved = resolveSpecifier(sourceNode.value, filename)
      const fencedNames = resolved && FENCED_EXPORTS.get(resolved)
      return fencedNames ? { alias: aliasOf(resolved), fencedNames } : null
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return
        if (checkModuleSource(node, node.source)) return
        const fenced = fencedExportsOf(node.source)
        if (!fenced) return
        for (const specifier of node.specifiers) {
          if (specifier.importKind === 'type') continue
          if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
            // `import * as storage from ...` / `import storage from ...` reaches every fenced name.
            check(specifier, `${fenced.alias}#*`, 'fencedNamespace')
            continue
          }
          if (specifier.type !== 'ImportSpecifier') continue
          const imported = specifierName(specifier.imported)
          if (fenced.fencedNames.has(imported)) check(specifier, `${fenced.alias}#${imported}`)
        }
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return
        if (checkModuleSource(node, node.source)) return
        const fenced = fencedExportsOf(node.source)
        if (!fenced) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type') continue
          // `local` is the name as the source module exports it; `exported` is the alias here.
          const local = specifierName(specifier.local)
          if (fenced.fencedNames.has(local)) check(specifier, `${fenced.alias}#${local}`)
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return
        if (checkModuleSource(node, node.source)) return
        const fenced = fencedExportsOf(node.source)
        // `export * from ...` / `export * as ns from ...` re-exports every fenced name.
        if (fenced) check(node, `${fenced.alias}#*`, 'fencedNamespace')
      },
      ImportExpression(node) {
        if (node.source.type !== 'Literal') return
        if (checkModuleSource(node, node.source)) return
        // `const { getAgentWorkspaceDir } = await import('.../data-dir')`
        const fenced = fencedExportsOf(node.source)
        if (!fenced) return
        const awaited = node.parent && node.parent.type === 'AwaitExpression' ? node.parent : null
        const declarator = awaited && awaited.parent && awaited.parent.type === 'VariableDeclarator' ? awaited.parent : null
        if (!declarator || declarator.id.type !== 'ObjectPattern') return
        for (const property of declarator.id.properties) {
          if (property.type !== 'Property' || property.key.type !== 'Identifier') continue
          if (fenced.fencedNames.has(property.key.name)) check(property, `${fenced.alias}#${property.key.name}`)
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal'
        ) {
          checkModuleSource(node, node.arguments[0])
        }
      },
      'Program:exit'(node) {
        for (const key of allowed) {
          if (!seen.has(key)) context.report({ node, messageId: 'stale', data: { key } })
        }
      },
    }
  },
}
