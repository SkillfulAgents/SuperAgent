/**
 * Deliver File Tool - Allows agents to send files to users
 *
 * This tool is non-blocking. The agent provides a file path and optional description,
 * the tool validates the file exists, and the frontend renders a download link.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createHash } from 'crypto'
import { z } from 'zod'
import { openWorkspaceFile, WorkspaceFileError } from '../workspace-file-transfer'

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
      const file = await openWorkspaceFile(args.filePath)
      const hash = createHash('sha256')
      let bytesRead = 0
      for await (const chunk of file.stream) {
        hash.update(chunk)
        bytesRead += chunk.length
      }
      if (bytesRead !== file.size) throw new WorkspaceFileError('File changed while it was being delivered; retry delivery after the file is complete', 409)
      // The trailing `Delivered: {...}` line is the renderer contract (read back
      // by src/shared/lib/tool-definitions/deliver-file.ts): the tool already
      // stat'd the file, so the size travels as data rather than as a number the
      // renderer has to scrape out of the sentence above it. The prose is what
      // the model reasons over; the JSON line is what the UI parses.
      const delivered = JSON.stringify({ sizeBytes: file.size, sha256: hash.digest('hex') })
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
        : 'Unable to read the file for delivery; try again after the file is complete'
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
