import * as path from 'path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { writeWorkspaceFile } from '../../workspace-file-transfer'
import { authenticatedHostResponse, textResult, XAgentError } from './host-client'

interface DownloadAgentFileArgs {
  slug: string
  session_id: string
  delivery_id: string
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // Fall through to the plain filename.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/.exec(header)
  return (plain?.[1] ?? plain?.[2])?.trim() || null
}

export function safeAgentDownloadFilename(candidate: string | null, fallback: string): string {
  const basename = path.posix.basename((candidate || fallback).replace(/\\/g, '/'))
  // eslint-disable-next-line no-control-regex
  const cleaned = basename.replace(/[\x00-\x1f<>:"|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '')
  const safe = cleaned || 'agent-file'
  if (safe.length <= 180) return safe
  const extension = path.extname(safe)
  return safe.slice(0, 180 - extension.length) + extension
}

function safeAgentDirectory(slug: string): string {
  const cleaned = slug.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+|[.]+$/g, '').slice(0, 100)
  return cleaned || 'agent'
}

export async function downloadAgentFile(
  args: DownloadAgentFileArgs,
  workspaceRoot = '/workspace',
): Promise<{ path: string; bytes: number }> {
  const response = await authenticatedHostResponse('download-file', {
    slug: args.slug,
    sessionId: args.session_id,
    deliveryId: args.delivery_id,
  })
  const filename = safeAgentDownloadFilename(
    filenameFromContentDisposition(response.headers.get('Content-Disposition')),
    `agent-file-${args.delivery_id}`,
  )
  const directory = safeAgentDirectory(args.slug)
  const written = await writeWorkspaceFile(
    `downloads/x-agent/${directory}/${filename}`,
    response.body,
    { workspaceRoot, collisionSafe: true },
  )
  return { path: written.path, bytes: written.size }
}

export const downloadAgentFileTool = tool(
  'download_agent_file',
  `Download a file delivered by another agent into this agent's workspace.

Use the slug, session_id, and delivery_id printed by get_agent_session_transcript. The destination is always selected safely below /workspace/downloads/x-agent/<callee>/; existing files are never overwritten.`,
  {
    slug: z.string().min(1).describe('Slug of the agent that delivered the file'),
    session_id: z.string().min(1).describe('Session ID containing the delivered file'),
    delivery_id: z.string().min(1).describe('Delivery ID from get_agent_session_transcript'),
  },
  async (args) => {
    try {
      const downloaded = await downloadAgentFile(args)
      return textResult(`Downloaded ${downloaded.bytes} bytes to ${downloaded.path}`)
    } catch (error) {
      const message = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to download agent file: ${message}`, true)
    }
  },
)
