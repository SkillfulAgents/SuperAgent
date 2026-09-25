import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from '../web/host-client'
import { imageDataUrl } from './image-input'
import type { MediaToolFactory } from './index'

export const grokMediaTools: MediaToolFactory = ({ generateImages }) => [
  tool(
    'grok_generate_image',
    `Generate or edit an image with the user's connected Grok (SuperGrok / X Premium) subscription, using Grok Imagine.

Uses the subscription's daily image allowance. To edit, restyle or combine existing images, pass them as referenced_image_paths and refer to them in the prompt. Returns the saved file paths.`,
    {
      prompt: z.string().min(1).describe('A complete description of the image to generate, or of the edit to apply to the referenced images.'),
      aspect_ratio: z.enum(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '21:9']).optional().describe('Output aspect ratio. Edits follow the input when omitted.'),
      resolution: z.enum(['1k', '2k']).optional().describe('Output resolution. Defaults to 1k.'),
      referenced_image_paths: z.array(z.string()).max(5).optional().describe('Absolute paths of up to 5 PNG, JPEG or WebP images to edit or use as references.'),
    },
    async (args) => {
      try {
        const images = await Promise.all((args.referenced_image_paths ?? []).map(imageDataUrl))
        const files = await generateImages({ prompt: args.prompt, aspectRatio: args.aspect_ratio, resolution: args.resolution, images })
        return textResult(`Generated with Grok:\n${files.join('\n')}`)
      } catch (error) {
        return textResult(`Grok image generation failed: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  ),
]
