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

const BINARY_EXTS = new Set([
  ...[...IMAGE_EXTS].filter(ext => ext !== 'svg'),
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
  'pdf', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'jar',
  'db', 'sqlite', 'sqlite3',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
])

/**
 * An extension can only rule formats *out* — there is no list that covers every
 * text file an agent might write. So anything not known to be binary is treated
 * as copyable, which is what lets extensionless files (LICENSE, Procfile) and
 * unfamiliar code extensions get a copy action at all. `looksBinary` is the
 * actual guard: it inspects the bytes we fetched before they reach the
 * clipboard, so a wrong guess here costs an error toast, not garbage.
 */
export function isCopyableTextFile(filePath: string): boolean {
  return !BINARY_EXTS.has(getFileExtension(filePath))
}

const BINARY_SNIFF_CHARS = 8000
const MAX_REPLACEMENT_RATIO = 0.1

/**
 * Git's heuristic: a NUL byte in the first few KB means binary. Decoding via
 * `Response.text()` also turns any byte sequence that isn't valid UTF-8 into
 * U+FFFD, so a high density of those is the second tell.
 */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, BINARY_SNIFF_CHARS)

  let replacements = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code === 0x0000) return true
    if (code === 0xfffd) replacements++
  }
  return replacements / sample.length > MAX_REPLACEMENT_RATIO
}

