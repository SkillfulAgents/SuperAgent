/**
 * Deliver File Tool - Allows agents to send files to users
 *
 * This tool is non-blocking. The agent provides a file path and optional description,
 * the tool validates the file exists, and the frontend renders a download link.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'

export const deliverFileTool = tool(
  'deliver_file',
  `Deliver a file to the user. Provide the path to a file in your workspace that you want the user to be able to download. The file will be presented as a download link in the user's chat interface.

Use this when you've created, processed, or fetched a file that the user needs to download.

Example usage:
- filePath: "/workspace/output/report.pdf" - User can download the generated report
- filePath: "/workspace/data/results.csv" - User can download processed data`,
  {
    filePath: z
      .string()
      .describe(
        'Path to the file in the workspace (e.g., /workspace/output/report.pdf)'
      ),
    description: z
      .string()
      .optional()
      .describe('Brief description of the file being delivered'),
  },
  async (args) => {
    const fullPath = args.filePath.startsWith('/workspace/')
      ? args.filePath
      : path.join('/workspace', args.filePath)

    try {
      const stats = await fs.promises.stat(fullPath)
      if (!stats.isFile()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${args.filePath} is not a file.`,
            },
          ],
          isError: true,
        }
      }

      const relativePath = path.relative('/workspace', fullPath)
      return {
        content: [
          {
            type: 'text' as const,
            text: `File "${relativePath}" (${stats.size} bytes) has been delivered to the user. They can now download it from the chat.`,
          },
        ],
      }
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: File not found at ${args.filePath}`,
          },
        ],
        isError: true,
      }
    }
  }
)
