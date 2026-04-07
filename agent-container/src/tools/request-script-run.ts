import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

export const requestScriptRunTool = tool(
  'request_script_run',
  `Request the host machine to execute a script. The script runs on the user's desktop (outside the container) and requires explicit user approval before execution.

Before using this tool, check the HOST_PLATFORM environment variable:
- If HOST_PLATFORM is "darwin": use scriptType "applescript" or "shell"
- If HOST_PLATFORM is "win32": use scriptType "powershell"

Each invocation requires the user to click "Run" or "Deny" in the UI. Always provide a clear explanation of what the script does so the user can make an informed decision.

Examples:
- Open a URL: scriptType "applescript", script: 'open location "https://example.com"'
- Run a shell command: scriptType "shell", script: 'ls -la ~/Documents'
- PowerShell on Windows: scriptType "powershell", script: 'Get-Process | Select-Object -First 5'`,
  {
    script: z.string().describe('The script code to execute on the host machine'),
    explanation: z.string().describe("A question for the user following the pattern 'Allow {what the script does}?'. Plain English, never use first person. Must end with '?'. Example: 'Allow opening the project URL in the default browser?'"),
    scriptType: z.enum(['applescript', 'shell', 'powershell']).describe(
      'The type of script to execute. Check HOST_PLATFORM env var: darwin → applescript or shell, win32 → powershell'
    ),
  },
  async (args) => {
    console.log(`[request_script_run] Requesting script execution (${args.scriptType}): ${args.explanation}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()

    if (!toolUseId) {
      console.error('[request_script_run] No toolUseId available')
      return {
        content: [{ type: 'text' as const, text: 'Unable to process script run request - no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const output = await inputManager.createPendingWithType<string>(toolUseId, 'script_run', {
        script: args.script,
        explanation: args.explanation,
        scriptType: args.scriptType,
      })

      return {
        content: [{ type: 'text' as const, text: output || 'Script executed successfully (no output).' }],
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.log(`[request_script_run] Request failed: ${errorMessage}`)

      return {
        content: [{ type: 'text' as const, text: `Script execution request failed: ${errorMessage}` }],
        isError: true,
      }
    }
  }
)
