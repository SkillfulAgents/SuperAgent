import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from '../web/host-client'
import { imageDataUrl } from './image-input'
import type { MediaToolFactory } from './index'

const VIDEO_WAIT_MS = 4 * 60_000

function videoResult(job: string, file: string | undefined) {
  return textResult(file
    ? `Generated with Grok:\n${file}`
    : `The Grok video is still rendering. Call grok_get_video with job_id "${job}" to keep waiting.`)
}
function failure(kind: string, error: unknown) {
  return textResult(`Grok ${kind} failed: ${error instanceof Error ? error.message : String(error)}`, true)
}

export const grokMediaTools: MediaToolFactory = ({ generateImages, startVideo, waitForVideo }) => [
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
  tool(
    'grok_generate_video',
    `Generate a short video (1-15 seconds) with the user's connected Grok subscription, using Grok Imagine. Optionally animate a still image.

Uses the subscription's daily video allowance. Waits up to 4 minutes; if the video is still rendering, returns a job_id for grok_get_video. Returns the saved file path.`,
    {
      prompt: z.string().min(1).describe('A complete description of the video, including motion and camera movement.'),
      image_path: z.string().optional().describe('Absolute path of a PNG, JPEG or WebP image to use as the first frame.'),
      duration: z.number().int().min(1).max(15).optional().describe('Length in seconds.'),
      aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']).optional().describe('Output aspect ratio.'),
      resolution: z.enum(['480p', '720p', '1080p']).optional().describe('Output resolution.'),
    },
    async (args) => {
      try {
        const image = args.image_path ? await imageDataUrl(args.image_path) : undefined
        const job = await startVideo({ prompt: args.prompt, image, duration: args.duration, aspectRatio: args.aspect_ratio, resolution: args.resolution })
        return videoResult(job, await waitForVideo(job, VIDEO_WAIT_MS))
      } catch (error) {
        return failure('video generation', error)
      }
    },
  ),
  tool(
    'grok_get_video',
    'Keep waiting for a Grok video started by grok_generate_video. Waits up to 4 minutes and returns the saved file path when it is ready.',
    { job_id: z.string().min(1).describe('The job_id returned by grok_generate_video.') },
    async (args) => {
      try {
        return videoResult(args.job_id, await waitForVideo(args.job_id, VIDEO_WAIT_MS))
      } catch (error) {
        return failure('video generation', error)
      }
    },
  ),
]
