/**
 * Count the agent actor's escape hatches per file.
 *
 * `actor.container.fetch()` lets a caller speak to the container API itself
 * instead of asking the actor for the operation. It is transport-shaped, so a
 * remote actor can honour it, but each call is still a place where a route
 * knows the container's HTTP surface. This rule reports one warning per file
 * with the counts so the total is visible in every lint run. It is a meter,
 * not a gate, and never fails CI.
 *
 * `hostBridgeIp()` and `probeHostPort()` are not counted: they describe the
 * host machine, not the container's transport, and stay as capabilities that a
 * remote actor answers with null / 'unknown'. `files.workspacePath()` used to
 * be counted here; it no longer exists.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const ESCAPE_HATCHES = new Map([
  ['container', new Set(['fetch'])],
])

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Report how many agent-actor escape hatches (container.fetch, files.workspacePath, ...) a file calls',
    },
    schema: [],
    messages: {
      tally: '{{total}} agent-actor escape-hatch call(s) in this file: {{breakdown}}',
    },
  },

  create(context) {
    const counts = new Map()

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return
        const group = callee.object
        if (group.type !== 'MemberExpression' || group.property.type !== 'Identifier') return
        const hatches = ESCAPE_HATCHES.get(group.property.name)
        if (!hatches || !hatches.has(callee.property.name)) return
        const key = `${group.property.name}.${callee.property.name}`
        counts.set(key, (counts.get(key) || 0) + 1)
      },
      'Program:exit'(node) {
        if (counts.size === 0) return
        let total = 0
        const parts = []
        for (const [key, count] of [...counts.entries()].sort()) {
          total += count
          parts.push(`${key} ×${count}`)
        }
        context.report({ node, messageId: 'tally', data: { total: String(total), breakdown: parts.join(', ') } })
      },
    }
  },
}
