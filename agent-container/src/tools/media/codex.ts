import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from '../web/host-client'
import { imageDataUrl } from './image-input'
import type { MediaToolFactory } from './index'

export const codexMediaTools: MediaToolFactory = ({ generateImages }) => [
  tool(
    'codex_generate_image',
    `Generate or edit an image with the user's connected Codex (ChatGPT) subscription, using gpt-image-2.

Image generation uses the subscription's Codex allowance faster than text. To edit or restyle existing images, pass them as referenced_image_paths. Returns the saved file paths.`,
    {
      prompt: z.string().min(1).describe('A complete description of the image to generate, or of the edit to apply to the referenced images.'),
      transparent_background: z.boolean().optional().describe('Whether the output should have a transparent background. Defaults to false.'),
      referenced_image_paths: z.array(z.string()).max(5).optional().describe('Absolute paths of up to 5 PNG, JPEG or WebP images to edit or use as references.'),
    },
    async (args) => {
      try {
        const images = await Promise.all((args.referenced_image_paths ?? []).map(imageDataUrl))
        const files = await generateImages({ prompt: args.prompt, transparentBackground: args.transparent_background ?? false, images })
        return textResult(`Generated with Codex:\n${files.join('\n')}`)
      } catch (error) {
        return textResult(`Codex image generation failed: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  ),
]
