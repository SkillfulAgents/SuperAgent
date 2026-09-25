import { createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { callWebHost } from '../web/host-client'
import { codexMediaTools } from './codex'
import { grokMediaTools } from './grok'

const generatedMediaSchema = z.object({ mimeType: z.string(), base64: z.string().min(1) })
type GeneratedMedia = z.infer<typeof generatedMediaSchema>
const generatedMediaResponseSchema = z.object({ images: z.array(generatedMediaSchema) })
const videoStartResponseSchema = z.object({ job: z.string().min(1) })
const videoStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('done'), video: generatedMediaSchema }),
  z.object({ status: z.literal('failed'), error: z.string() }),
])
const VIDEO_POLL_MS = 5_000

export interface MediaToolContext {
  /** Generates through the host and returns the saved file paths. */
  generateImages(input: Record<string, unknown>): Promise<string[]>
  /** Starts a video job and returns its handle. */
  startVideo(input: Record<string, unknown>): Promise<string>
  /** Waits up to timeoutMs; returns the saved path, or undefined while still rendering. */
  waitForVideo(job: string, timeoutMs: number): Promise<string | undefined>
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each provider owns its own schema
export type MediaToolFactory = (context: MediaToolContext) => SdkMcpToolDefinition<any>[]

// Provider-owned tools, keyed by host media provider id. Tool names are
// prefixed with the provider, e.g. mcp__media__codex_generate_image.
export const MEDIA_TOOLS: Record<string, MediaToolFactory> = {
  codex: codexMediaTools,
  grok: grokMediaTools,
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' }

/** Host-connected providers that this container has tools for. */
export function mediaToolProviders(available: readonly string[] = []): string[] {
  return available.filter(id => Object.hasOwn(MEDIA_TOOLS, id))
}

export async function saveGeneratedMedia(provider: string, media: GeneratedMedia[], directory: string): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return Promise.all(media.map(async (item, index) => {
    const file = path.join(directory, `${provider}-${stamp}-${index + 1}.${EXTENSIONS[item.mimeType] ?? 'bin'}`)
    await writeFile(file, Buffer.from(item.base64, 'base64'))
    return file
  }))
}

export function mediaToolContext(provider: string, directory: string, pollMs = VIDEO_POLL_MS): MediaToolContext {
  return {
    async generateImages(input) {
      const { images } = generatedMediaResponseSchema.parse(await callWebHost('subscription-media', `${provider}/image`, input))
      return saveGeneratedMedia(provider, images, directory)
    },
    async startVideo(input) {
      return videoStartResponseSchema.parse(await callWebHost('subscription-media', `${provider}/video`, input)).job
    },
    async waitForVideo(job, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const result = videoStatusResponseSchema.parse(await callWebHost('subscription-media', `${provider}/video/status`, { job }))
        if (result.status === 'done') return (await saveGeneratedMedia(provider, [result.video], directory))[0]
        if (result.status === 'failed') throw new Error(result.error)
        if (Date.now() + pollMs > deadline) return undefined
        await new Promise(resolve => setTimeout(resolve, pollMs))
      }
    },
  }
}

export function createMediaMcpServer(providers: readonly string[], workingDirectory: string) {
  const directory = path.join(workingDirectory, 'media')
  return createSdkMcpServer({
    name: 'media',
    version: '1.0.0',
    tools: providers.flatMap(provider => MEDIA_TOOLS[provider](mediaToolContext(provider, directory))),
  })
}
