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

/**
 * Coarse file-type categories shared by the preview and the file icon. An
 * extension belongs to at most one category; unknown extensions are `other`.
 */
export type FileCategory =
  | 'document'
  | 'text'
  | 'code'
  | 'data'
  | 'config'
  | 'shell'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'font'
  | 'model'
  | 'other'

const DOCUMENT_EXTS = new Set(['pdf', 'doc', 'docx', 'odt', 'fodt', 'rtf', 'pages', 'epub', 'wpd', 'wps', 'tex'])
const PLAIN_TEXT_EXTS = new Set(['txt', 'log', 'text', 'readme', 'license'])
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'java', 'kt', 'swift', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'cs', 'r', 'scala', 'dart', 'lua', 'pl', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'sql', 'graphql',
  'proto', 'asp', 'aspx', 'jsp',
])
const DATA_EXTS = new Set(['json', 'jsonl', 'xml', 'parquet', 'avro', 'ndjson', 'geojson'])
const CONFIG_EXTS = new Set(['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'plist', 'properties', 'editorconfig', 'lock'])
const SHELL_EXTS = new Set(['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'])
const SPREADSHEET_EXTS = new Set(['xls', 'xlsx', 'xlsm', 'xlr', 'ods', 'fods', 'numbers', ...CSV_EXTS])
const PRESENTATION_EXTS = new Set(['ppt', 'pptx', 'odp', 'fodp', 'key'])
const IMAGE_CATEGORY_EXTS = new Set([...IMAGE_EXTS, 'tif', 'tiff', 'heic', 'avif', 'psd', 'ai', 'eps', 'indd', 'sketch', 'fig'])
const VIDEO_CATEGORY_EXTS = new Set([...VIDEO_EXTS, 'avi', 'mkv', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', '3g2', 'asf', 'rm', 'swf'])
const AUDIO_CATEGORY_EXTS = new Set([...AUDIO_EXTS, 'aif', 'aiff', 'mid', 'midi', 'wma'])
const ARCHIVE_EXTS = new Set(['zip', 'zipx', '7z', '7zip', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'sitx', 'dmg', 'pkg', 'apk', 'apkm', 'apks', 'xapk', 'aab', 'jar'])
const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot', 'fnt', 'fon'])
const MODEL_EXTS = new Set(['3dm', '3ds', 'obj', 'max', 'dwg', 'dxf', 'skp', 'stl', 'fbx', 'glb', 'gltf', 'blend'])

const CATEGORY_SETS: [FileCategory, Set<string>][] = [
  ['document', DOCUMENT_EXTS],
  ['text', new Set([...PLAIN_TEXT_EXTS, ...MARKDOWN_EXTS])],
  ['code', CODE_EXTS],
  ['data', DATA_EXTS],
  ['config', CONFIG_EXTS],
  ['shell', SHELL_EXTS],
  ['spreadsheet', SPREADSHEET_EXTS],
  ['presentation', PRESENTATION_EXTS],
  ['image', IMAGE_CATEGORY_EXTS],
  ['video', VIDEO_CATEGORY_EXTS],
  ['audio', AUDIO_CATEGORY_EXTS],
  ['archive', ARCHIVE_EXTS],
  ['font', FONT_EXTS],
  ['model', MODEL_EXTS],
]

/** Category for a filename or path, keyed on its lowercase extension. */
export function fileCategory(filePath: string): FileCategory {
  const ext = getFileExtension(filePath)
  for (const [category, exts] of CATEGORY_SETS) {
    if (exts.has(ext)) return category
  }
  return 'other'
}

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

