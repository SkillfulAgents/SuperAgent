/**
 * Flag path-containment checks written as `resolvedPath.startsWith(baseDir)`.
 *
 * A bare prefix check is unsafe: a sibling directory sharing the base's string
 * prefix passes it (base `/data/agent` vs `/data/agent-victim`). See SUP-200.
 * Use `isPathWithinDir()` / `assertPathWithinDir()` from
 * `@shared/lib/utils/path-safety`, which compare via `path.relative`.
 *
 * Heuristic: report `<receiver>.startsWith(...)` when `<receiver>` is
 *   (a) an inline `path.resolve(...)` / `path.join(...)` call, or
 *   (b) an identifier initialized from `path.resolve(...)` / `path.join(...)`
 *       somewhere in the visible scope chain.
 * This catches both the inline and the stored-variable forms. It will not catch
 * a resolved path passed through several intermediate variables — those are rare
 * and the runtime helper remains the real safety net.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow path-containment checks via startsWith(); use isPathWithinDir/assertPathWithinDir from @shared/lib/utils/path-safety',
    },
    schema: [],
    messages: {
      pathStartsWith:
        "Unsafe path-containment check: '.startsWith()' on a path.resolve/join result lets a sibling dir sharing the prefix escape. Use isPathWithinDir()/assertPathWithinDir() from '@shared/lib/utils/path-safety'.",
    },
  },

  create(context) {
    const PATH_METHODS = new Set(['resolve', 'join'])

    function isPathResolveCall(node) {
      return (
        node &&
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'path' &&
        node.callee.property.type === 'Identifier' &&
        PATH_METHODS.has(node.callee.property.name)
      )
    }

    function getScopeForNode(node) {
      // ESLint 9 prefers sourceCode.getScope(node); ESLint 8 uses getScope().
      const sourceCode = context.sourceCode || context.getSourceCode()
      if (sourceCode && typeof sourceCode.getScope === 'function') {
        return sourceCode.getScope(node)
      }
      return context.getScope()
    }

    // True if `node` is an identifier whose nearest binding was initialized from
    // a path.resolve/join call.
    function identifierFromPathResolve(node) {
      if (!node || node.type !== 'Identifier') return false
      let scope = getScopeForNode(node)
      let variable = null
      while (scope && !variable) {
        variable = scope.variables.find((v) => v.name === node.name) || null
        scope = scope.upper
      }
      if (!variable) return false
      return variable.defs.some(
        (def) =>
          def.node &&
          def.node.type === 'VariableDeclarator' &&
          def.node.init &&
          isPathResolveCall(def.node.init),
      )
    }

    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'startsWith'
        ) {
          return
        }
        const receiver = callee.object
        if (isPathResolveCall(receiver) || identifierFromPathResolve(receiver)) {
          context.report({ node, messageId: 'pathStartsWith' })
        }
      },
    }
  },
}
