import { createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { callWebHost } from '../web/host-client'
import { codexMediaTools } from './codex'

const generatedMediaResponseSchema = z.object({
  images: z.array(z.object({ mimeType: z.string(), base64: z.string().min(1) })),
})
type GeneratedMedia = z.infer<typeof generatedMediaResponseSchema>['images'][number]

export interface MediaToolContext {
  /** Generates through the host and returns the saved file paths. */
  generateImages(input: Record<string, unknown>): Promise<string[]>
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each provider owns its own schema
export type MediaToolFactory = (context: MediaToolContext) => SdkMcpToolDefinition<any>[]

// Provider-owned tools, keyed by host media provider id. Tool names are
// prefixed with the provider, e.g. mcp__media__codex_generate_image.
export const MEDIA_TOOLS: Record<string, MediaToolFactory> = {
  codex: codexMediaTools,
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

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

export function createMediaMcpServer(providers: readonly string[], workingDirectory: string) {
  const directory = path.join(workingDirectory, 'media')
  return createSdkMcpServer({
    name: 'media',
    version: '1.0.0',
    tools: providers.flatMap(provider => MEDIA_TOOLS[provider]({
      async generateImages(input) {
        const { images } = generatedMediaResponseSchema.parse(await callWebHost('subscription-media', `${provider}/image`, input))
        return saveGeneratedMedia(provider, images, directory)
      },
    })),
  })
}
