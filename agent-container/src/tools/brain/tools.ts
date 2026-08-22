import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { executeBrainRead } from './read'
import { executeBrainWrite } from './write'

export const brainReadTool = tool(
  'brain_read',
  'Read a Team Brain page by name. Start with INDEX.md to see the catalog. Then read a named page.',
  { name: z.string().describe('Page name, such as INDEX.md or a catalog slug') },
  async (args) => executeBrainRead(args.name),
)

export function makeBrainWriteTool(getCallerSessionId: () => string) {
  return tool(
    'brain_write',
    'Write a Team Brain page if you are the curator (name + body, or delete). Otherwise send a request. A request invokes the curator the same way invoke_agent does, including the allow step. Only the curator persists. Only the curator updates INDEX.md. INDEX.md cannot be deleted.',
    {
      request: z.string().optional().describe('Write request for the curator. Use this if you are not the curator.'),
      name: z.string().optional().describe('Page name. Curator only.'),
      body: z.string().optional().describe('Full markdown body. Curator only.'),
      delete: z.boolean().optional().describe('Delete the named page. Curator only. Cannot delete INDEX.md.'),
    },
    async (args) => executeBrainWrite(args, getCallerSessionId()),
  )
}
