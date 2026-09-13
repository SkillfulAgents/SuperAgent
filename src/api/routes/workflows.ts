import { Hono } from 'hono'
import { AgentRead } from '../middleware/auth'
import { agentRegistry, WorkspaceFileError } from '@shared/lib/agent-actor'
import { transformMessages } from '@shared/lib/utils/message-transform'
import { streamJsonArrayResponse } from '../stream-json-array'

/**
 * Read-only routes backing the per-agent workflow drawer (SUP-308). A dynamic
 * workflow's per-agent tree + transcripts live only on disk (the SDK wire carries
 * nothing about the internal agents), so these read them through the agent
 * actor, mirroring the regular subagent transcript route. Mounted into the
 * `agents` router at the `/api/agents` root.
 */
export const workflowRoutes = new Hono()

// Per-agent tree for a dynamic-workflow run (phases + agent status/label/result).
workflowRoutes.get('/:id/sessions/:sessionId/workflows/:runId/tree', AgentRead(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const runId = c.req.param('runId')
    // runId indexes into the filesystem; allow only the `wf_...` shape (blocks traversal).
    if (!/^wf_[\w-]+$/.test(runId)) {
      return c.json({ error: 'Invalid workflow run id' }, 400)
    }

    const tree = await agentRegistry.get(agentSlug).sessions.workflowTree(sessionId, runId)
    if (!tree) {
      return c.json({ error: 'Workflow run not found' }, 404)
    }
    return c.json(tree)
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return c.json({ error: 'Invalid workflow run id' }, 400)
    }
    console.error('Failed to build workflow tree:', error)
    return c.json({ error: 'Failed to build workflow tree' }, 500)
  }
})

// One workflow subagent's transcript (same contract the drawer already renders).
workflowRoutes.get(
  '/:id/sessions/:sessionId/workflows/:runId/agents/:agentId/messages',
  AgentRead(),
  async (c) => {
    try {
      const agentSlug = c.req.param('id')
      const sessionId = c.req.param('sessionId')
      const runId = c.req.param('runId')
      const workflowAgentId = c.req.param('agentId')
      // Both ids index into the filesystem; constrain them to block path traversal.
      if (!/^wf_[\w-]+$/.test(runId) || !/^[\w-]+$/.test(workflowAgentId)) {
        return c.json({ error: 'Invalid workflow run or agent id' }, 400)
      }

      const entries = (await agentRegistry
        .get(agentSlug)
        .sessions.workflowAgentTranscript(sessionId, runId, workflowAgentId)) as any[]
      const messageEntries = entries.filter((e) => e.type === 'user' || e.type === 'assistant')
      const transformed = transformMessages(messageEntries)
      // Polled while the workflow drawer is open, so stream the serialization
      // instead of building one JSON string per poll.
      return streamJsonArrayResponse(c, transformed, {
        logLabel: 'workflow agent messages',
        tags: { component: 'workflows', operation: 'stream-workflow-agent-messages' },
      })
    } catch (error) {
      if (error instanceof WorkspaceFileError) {
        return c.json({ error: 'Invalid workflow run or agent id' }, 400)
      }
      console.error('Failed to fetch workflow agent messages:', error)
      return c.json({ error: 'Failed to fetch workflow agent messages' }, 500)
    }
  }
)
