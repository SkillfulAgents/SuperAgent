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
      // The trailing `Delivered: {...}` line is the renderer contract (read back
      // by src/shared/lib/tool-definitions/deliver-file.ts): the tool already
      // stat'd the file, so the size travels as data rather than as a number the
      // renderer has to scrape out of the sentence above it. The prose is what
      // the model reasons over; the JSON line is what the UI parses.
      const delivered = JSON.stringify({ sizeBytes: stats.size })
      return {
        content: [
          {
            type: 'text' as const,
            text: `File "${relativePath}" (${stats.size} bytes) has been delivered to the user. They can now download it from the chat.\n\nHint: If this is a file the user will access frequently (e.g. a report, dashboard, or reference doc), consider adding it to /workspace/bookmarks.json so it appears on their agent homepage.\n\nDelivered: ${delivered}`,
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
