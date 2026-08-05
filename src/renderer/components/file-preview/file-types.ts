import { getFileExtension } from '@shared/lib/utils/mime'

export const MARKDOWN_EXTS = new Set(['md', 'markdown'])
export const CSV_EXTS = new Set(['csv', 'tsv'])
export const TEXT_EXTS = new Set([
  'txt', 'log', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'env', 'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'tsx', 'jsx', 'css',
  'scss', 'less', 'sql', 'graphql', 'proto', 'dockerfile', 'makefile',
  'gitignore', 'editorconfig', 'rs', 'go', 'java', 'kt', 'swift', 'rb', 'php',
  'c', 'cpp', 'h', 'hpp', 'r',
])
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v', 'ogv'])
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'])

const COPYABLE_TEXT_EXTS = new Set([
  ...MARKDOWN_EXTS,
  ...CSV_EXTS,
  ...TEXT_EXTS,
  'html',
  'htm',
  'svg',
])

export function isCopyableTextFile(filePath: string): boolean {
  return COPYABLE_TEXT_EXTS.has(getFileExtension(filePath))
}
