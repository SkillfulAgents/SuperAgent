/**
 * Fence the agent internals behind the agent actor.
 *
 * The container manager, the message persister, and the user-input, review,
 * computer-use, and MCP re-auth registries are per-agent state. Code outside
 * the container layer and the actor package must reach them through
 * `agentRegistry.get(slug)` from `@shared/lib/agent-actor`, never by import.
 * `getAgentWorkspaceDir` is fenced the same way: the actor's
 * `files.workspacePath()` is the one sanctioned way to learn where an agent's
 * workspace is.
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
  'src/shared/lib/user-input/request-manager',
  'src/shared/lib/proxy/review-manager',
  'src/shared/lib/computer-use/permission-manager',
  'src/shared/lib/proxy/mcp-reauth-manager',
])

// Named exports fenced from modules that are otherwise open.
const FENCED_EXPORTS = new Map([
  ['src/shared/lib/config/data-dir', new Set(['getAgentWorkspaceDir'])],
  ['src/shared/lib/utils/file-storage', new Set(['getAgentWorkspaceDir'])],
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
        'Agent internals (container manager, message persister, input/review/permission registries, getAgentWorkspaceDir) may only be imported by the actor package; everything else goes through agentRegistry.get(slug)',
    },
    schema: [],
    messages: {
      fenced:
        "Agent-internal import '{{key}}': go through agentRegistry.get(slug) from '@shared/lib/agent-actor' instead. The allowlist in eslint-rules/agent-internals-allowlist.json only shrinks.",
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

    function check(node, key) {
      if (isInternal) return
      if (allowed.has(key)) {
        seen.add(key)
        return
      }
      context.report({ node, messageId: 'fenced', data: { key } })
    }

    function checkModuleSource(node, sourceNode) {
      if (!sourceNode || typeof sourceNode.value !== 'string') return
      const resolved = resolveSpecifier(sourceNode.value, filename)
      if (resolved && FENCED_MODULES.has(resolved)) check(node, aliasOf(resolved))
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return
        const resolved = resolveSpecifier(node.source.value, filename)
        if (!resolved) return
        if (FENCED_MODULES.has(resolved)) {
          check(node, aliasOf(resolved))
          return
        }
        const fencedNames = FENCED_EXPORTS.get(resolved)
        if (!fencedNames) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue
          const imported = specifier.imported.name || specifier.imported.value
          if (fencedNames.has(imported)) check(specifier, `${aliasOf(resolved)}#${imported}`)
        }
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return
        checkModuleSource(node, node.source)
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return
        checkModuleSource(node, node.source)
      },
      ImportExpression(node) {
        if (node.source.type !== 'Literal') return
        checkModuleSource(node, node.source)
        // `const { getAgentWorkspaceDir } = await import('.../data-dir')`
        const resolved = resolveSpecifier(node.source.value, filename)
        const fencedNames = resolved && FENCED_EXPORTS.get(resolved)
        if (!fencedNames) return
        const awaited = node.parent && node.parent.type === 'AwaitExpression' ? node.parent : null
        const declarator = awaited && awaited.parent && awaited.parent.type === 'VariableDeclarator' ? awaited.parent : null
        if (!declarator || declarator.id.type !== 'ObjectPattern') return
        for (const property of declarator.id.properties) {
          if (property.type !== 'Property' || property.key.type !== 'Identifier') continue
          if (fencedNames.has(property.key.name)) check(property, `${aliasOf(resolved)}#${property.key.name}`)
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
