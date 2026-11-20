import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callHost, textResult, XAgentError } from './host-client'
import { listModelsResultSchema } from './host-response-schemas'

export const makeListModelsTool = (getCallerSessionId: () => string) => tool(
  'list_models',
  `List the model accounts and their models that the person this session runs for can use, as they see them in the composer.

The account marked agentDefault is this agent's saved account: \`model\` is checked against it (for invoke_agent, the target agent's own account applies). If that account's default model can't run on the person's plan, the app's default account is used instead. A model marked unavailable cannot run on that person's plan. A model can be named by its id or its family alias.`,
  {},
  async () => {
    try {
      const data = await callHost('models', {}, listModelsResultSchema, { callerSessionId: getCallerSessionId() })
      return textResult(data.accounts.length ? JSON.stringify(data, null, 2) : 'No model accounts to list.')
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list models: ${msg}`, true)
    }
  },
)
