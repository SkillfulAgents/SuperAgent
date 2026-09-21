/**
 * Deliver File Tool - Allows agents to send files to users
 *
 * The agent provides a file path and optional description. The tool validates
 * confined regular-file metadata without reading contents, then the frontend
 * renders a download link.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveWorkspaceRegularFile, WorkspaceFileError } from '../workspace-file-transfer'

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
    try {
      const file = await resolveWorkspaceRegularFile(args.filePath)
      // The trailing `Delivered: {...}` line is the renderer contract (read back
      // by src/shared/lib/tool-definitions/deliver-file.ts): the tool already
      // stat'd the file, so the size travels as data rather than as a number the
      // renderer has to scrape out of the sentence above it. The prose is what
      // the model reasons over; the JSON line is what the UI parses.
      const delivered = JSON.stringify({ sizeBytes: file.size })
      return {
        content: [
          {
            type: 'text' as const,
            text: `File "${file.relativePath}" (${file.size} bytes) has been delivered to the user. They can now download it from the chat.\n\nHint: If this is a file the user will access frequently (e.g. a report, dashboard, or reference doc), consider adding it to /workspace/bookmarks.json so it appears on their agent homepage.\n\nDelivered: ${delivered}`,
          },
        ],
      }
    } catch (error) {
      const message = error instanceof WorkspaceFileError
        ? error.status === 404 ? `File not found at ${args.filePath}` : error.message
        : 'Unable to access the file for delivery'
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      }
    }
  }
)
