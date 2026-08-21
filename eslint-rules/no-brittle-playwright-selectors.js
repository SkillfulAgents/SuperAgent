/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow brittle Playwright waits and selectors in E2E tests',
    },
    schema: [],
    messages: {
      fixedTimeout:
        'Avoid page.waitForTimeout() in E2E tests. Wait for a user-visible state, network response, or app event instead.',
      classSelector:
        'Avoid CSS class selectors in Playwright tests. Classes are styling details; add/use a data-testid or semantic locator instead.',
      textEngine:
        'Avoid Playwright text= selectors. Prefer getByRole(), getByText(), or a stable data-testid scoped to the product concept.',
      hasTextPseudo:
        'Avoid :has-text() CSS selectors. Prefer getByRole(), getByText(), or locator.filter({ hasText }) scoped to a stable locator.',
      parentTraversal:
        "Avoid locator('..') parent traversal. Add/use a stable locator for the row or container instead.",
    },
  },

  create(context) {
    function propertyName(member) {
      if (member.property.type === 'Identifier') return member.property.name
      if (member.property.type === 'Literal') return String(member.property.value)
      return null
    }

    function staticString(node) {
      if (!node) return null
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
      }
      return null
    }

    function reportSelectorIssues(node, selector) {
      const trimmed = selector.trim()
      if (trimmed === '..') {
        context.report({ node, messageId: 'parentTraversal' })
        return
      }
      if (/(^|[\s>+~])\.[A-Za-z_-]/.test(trimmed)) {
        context.report({ node, messageId: 'classSelector' })
        return
      }
      if (/(^|\s|>>)text\s*=/i.test(trimmed)) {
        context.report({ node, messageId: 'textEngine' })
        return
      }
      if (/:has-text\s*\(/i.test(trimmed)) {
        context.report({ node, messageId: 'hasTextPseudo' })
      }
    }

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression') return

        const name = propertyName(callee)
        if (name === 'waitForTimeout') {
          context.report({ node, messageId: 'fixedTimeout' })
          return
        }

        if (name !== 'locator') return
        const selector = staticString(node.arguments[0])
        if (selector === null) return
        reportSelectorIssues(node, selector)
      },
    }
  },
}
