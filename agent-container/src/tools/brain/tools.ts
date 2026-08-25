import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { executeBrainWrite } from './write'

export const brainWriteShape = {
  request: z.string().describe('What to record, with the facts and their source.'),
}

export function makeBrainWriteTool(getCallerSessionId: () => string) {
  return tool(
    'brain_write',
    'Send a write request to the Team Brain curator. Invokes it like invoke_agent, allow step included, and returns the curator\'s last message.',
    brainWriteShape,
    async (args) => executeBrainWrite(args.request, getCallerSessionId()),
  )
}
