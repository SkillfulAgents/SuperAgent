/**
 * Request File Tool - Allows agents to request files from users
 *
 * This tool creates a pending request that blocks until the user uploads
 * a file or declines to provide one. The uploaded file path is returned
 * to the agent.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

export const requestFileTool = tool(
  'request_file',
  `Request a file from the user. The user will be prompted to upload a file through the UI.

Use this when you need the user to provide a file (document, image, data file, etc.) for processing.

After the user uploads the file, the tool will return the path where the file was saved in the workspace.

The user may also decline the request, optionally providing a reason.

Example usage:
- description: "Please upload the CSV file with sales data"
- description: "Please provide the logo image for the report" with fileTypes: ".png,.jpg,.svg"`,
  {
    description: z
      .string()
      .describe(
        'Description of the file you need from the user (e.g., "Please upload the CSV file with sales data")'
      ),
    fileTypes: z
      .string()
      .optional()
      .describe(
        'Accepted file types hint (e.g., ".csv,.xlsx" or "images"). This is advisory only.'
      ),
  },
  async (args) => {
    console.log(`[request_file] Requesting file: ${args.description}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()

    if (!toolUseId) {
      console.error(
        '[request_file] No toolUseId available - PreToolUse hook may not have fired'
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Unable to process file request - no tool use ID available.',
          },
        ],
        isError: true,
      }
    }

    console.log(`[request_file] Using toolUseId: ${toolUseId}`)

    try {
      // This blocks until the user uploads a file or declines
      const filePath = await inputManager.createPendingWithType<string>(
        toolUseId,
        'file_request',
        { description: args.description, fileTypes: args.fileTypes }
      )

      console.log(`[request_file] File uploaded to: ${filePath}`)

      return {
        content: [
          {
            type: 'text' as const,
            text: `User uploaded file to: ${filePath}`,
          },
        ],
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      console.log(
        `[request_file] File request failed: ${errorMessage}`
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `File request declined: ${errorMessage}. You may need to proceed without this file or ask the user for an alternative approach.`,
          },
        ],
        isError: true,
      }
    }
  }
)
