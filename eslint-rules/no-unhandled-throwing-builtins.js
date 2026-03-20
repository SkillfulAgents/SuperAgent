/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require try-catch around built-in functions that commonly throw',
    },
    schema: [],
    messages: {
      unhandled:
        "'{{name}}' can throw and should be wrapped in a try-catch block.',",
    },
  },

  create(context) {
    // method calls: e.g. JSON.parse
    const methodCalls = {
      JSON: new Set(['parse']),
    }

    // global function calls: e.g. decodeURIComponent("...")
    const globalCalls = new Set([
      'decodeURI',
      'decodeURIComponent',
      'atob',
    ])

    // global constructor calls: e.g. new URL("...")
    const constructorCalls = new Set(['URL'])

    function isInsideTryCatch(node) {
      let current = node.parent
      while (current) {
        if (current.type === 'TryStatement' && current.block) {
          // Check the call is inside the try block (not in catch/finally)
          let ancestor = node
          while (ancestor.parent !== current) {
            ancestor = ancestor.parent
          }
          if (ancestor === current.block) {
            return true
          }
        }
        current = current.parent
      }
      return false
    }

    function isInCatchCallback(node) {
      // Check if inside a .catch() or .then(_, onRejected) callback
      let current = node.parent
      while (current) {
        if (
          current.type === 'ArrowFunctionExpression' ||
          current.type === 'FunctionExpression'
        ) {
          const callExpr = current.parent
          if (
            callExpr &&
            callExpr.type === 'CallExpression' &&
            callExpr.callee.type === 'MemberExpression' &&
            callExpr.callee.property.name === 'catch'
          ) {
            return true
          }
        }
        current = current.parent
      }
      return false
    }

    function check(node, name) {
      if (!isInsideTryCatch(node) && !isInCatchCallback(node)) {
        context.report({
          node,
          messageId: 'unhandled',
          data: { name },
        })
      }
    }

    return {
      CallExpression(node) {
        const { callee } = node

        // JSON.parse(...), JSON.stringify(...)
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.property.type === 'Identifier' &&
          methodCalls[callee.object.name]?.has(callee.property.name)
        ) {
          check(node, `${callee.object.name}.${callee.property.name}`)
          return
        }

        // decodeURIComponent(...), atob(...)
        if (
          callee.type === 'Identifier' &&
          globalCalls.has(callee.name)
        ) {
          check(node, callee.name)
        }
      },

      NewExpression(node) {
        // new URL(...)
        if (
          node.callee.type === 'Identifier' &&
          constructorCalls.has(node.callee.name)
        ) {
          check(node, `new ${node.callee.name}`)
        }
      },
    }
  },
}
