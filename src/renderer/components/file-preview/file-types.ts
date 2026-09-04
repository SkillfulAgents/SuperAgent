/**
 * Coarse file-type categories shared by the preview and the file icon.
 * Unknown types are `other`.
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

/** The renderer that can show a file in the preview drawer. */
export type PreviewKind =
  | 'markdown'
  | 'html'
  | 'csv'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'

interface FileTypeGroup {
  category: FileCategory
  /** Renderer for these files; omitted when the drawer cannot preview them. */
  preview?: PreviewKind
  /** Extensions, without the dot. */
  exts?: readonly string[]
  /** Whole filenames that carry no extension, dotfiles included. */
  names?: readonly string[]
}

/**
 * The one file-type table: every extension and extensionless name we know,
 * with the icon category it belongs to and the renderer that can preview it.
 * Each key appears exactly once, so the icon and the preview can never
 * disagree about what a file is.
 */
const FILE_TYPES: readonly FileTypeGroup[] = [
  { category: 'document', preview: 'pdf', exts: ['pdf'] },
  { category: 'document', exts: ['doc', 'docx', 'odt', 'fodt', 'rtf', 'pages', 'epub', 'wpd', 'wps', 'tex'] },

  { category: 'text', preview: 'markdown', exts: ['md', 'markdown'] },
  {
    category: 'text',
    preview: 'text',
    exts: ['txt', 'log', 'text'],
    names: ['readme', 'license', 'licence', 'copying', 'notice', 'authors', 'contributors', 'changelog'],
  },

  {
    category: 'code',
    preview: 'text',
    exts: [
      'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'java', 'kt', 'swift', 'go', 'rs', 'c', 'cpp', 'h',
      'hpp', 'cs', 'r', 'scala', 'dart', 'lua', 'pl', 'css', 'scss', 'less', 'vue', 'svelte', 'sql', 'graphql',
      'proto', 'asp', 'aspx', 'jsp',
    ],
    names: ['makefile', 'rakefile', 'gemfile', 'brewfile', 'vagrantfile', 'justfile'],
  },
  { category: 'code', preview: 'html', exts: ['html', 'htm'] },

  { category: 'data', preview: 'text', exts: ['json', 'jsonl', 'ndjson', 'geojson', 'xml'] },
  { category: 'data', exts: ['parquet', 'avro'] },

  {
    category: 'config',
    preview: 'text',
    exts: ['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'lock'],
    names: [
      'dockerfile', 'containerfile', 'procfile', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig',
      '.env', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc',
    ],
  },
  { category: 'config', exts: ['plist'] },

  { category: 'shell', preview: 'text', exts: ['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'] },

  { category: 'spreadsheet', preview: 'csv', exts: ['csv', 'tsv'] },
  { category: 'spreadsheet', exts: ['xls', 'xlsx', 'xlsm', 'xlr', 'ods', 'fods', 'numbers'] },

  { category: 'presentation', exts: ['ppt', 'pptx', 'odp', 'fodp', 'key'] },

  { category: 'image', preview: 'image', exts: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] },
  { category: 'image', exts: ['tif', 'tiff', 'heic', 'avif', 'psd', 'ai', 'eps', 'indd', 'sketch', 'fig'] },

  { category: 'video', preview: 'video', exts: ['mp4', 'mov', 'webm', 'm4v', 'ogv'] },
  { category: 'video', exts: ['avi', 'mkv', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', '3g2', 'asf', 'rm', 'swf'] },

  { category: 'audio', preview: 'audio', exts: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'] },
  { category: 'audio', exts: ['aif', 'aiff', 'mid', 'midi', 'wma'] },

  {
    category: 'archive',
    exts: [
      'zip', 'zipx', '7z', '7zip', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'sitx', 'dmg', 'pkg', 'apk', 'apkm',
      'apks', 'xapk', 'aab', 'jar',
    ],
  },
  { category: 'font', exts: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'fnt', 'fon'] },
  { category: 'model', exts: ['3dm', '3ds', 'obj', 'max', 'dwg', 'dxf', 'skp', 'stl', 'fbx', 'glb', 'gltf', 'blend'] },
]

interface FileType {
  category: FileCategory
  preview?: PreviewKind
}

/** Extension → type, and extensionless name → type. Built once, read O(1). */
const BY_EXT = new Map<string, FileType>()
const BY_NAME = new Map<string, FileType>()

for (const { category, preview, exts, names } of FILE_TYPES) {
  const type: FileType = { category, preview }
  for (const ext of exts ?? []) BY_EXT.set(ext, type)
  for (const name of names ?? []) BY_NAME.set(name, type)
}

/** The extensions one renderer handles, read back out of the table. */
function extensionsFor(preview: PreviewKind): string[] {
  return [...BY_EXT].filter(([, type]) => type.preview === preview).map(([ext]) => ext)
}

/** Extensions the image renderer can display, so also the ones treated as pictures. */
export const IMAGE_EXTS = new Set(extensionsFor('image'))

/** Lowercased basename, with any trailing slash and directory prefix removed. */
function baseName(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  return (trimmed.split('/').pop() || trimmed).toLowerCase()
}

/**
 * Extension of a basename, or '' when it has none. A leading dot belongs to
 * the name, so `.gitignore` is an extensionless file rather than a `gitignore`
 * extension, and `Makefile` is not its own extension either.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/**
 * Type of a file, by name first and extension second: `Dockerfile` and
 * `.gitignore` are looked up whole, `report.pdf` by its extension, and
 * anything else is unknown.
 */
function fileType(filePath: string): FileType | undefined {
  const name = baseName(filePath)
  const named = BY_NAME.get(name)
  if (named) return named
  const ext = extensionOf(name)
  return ext ? BY_EXT.get(ext) : undefined
}

/** Category for a filename or path. */
export function fileCategory(filePath: string): FileCategory {
  return fileType(filePath)?.category ?? 'other'
}

/** Renderer for a filename or path, or null when the drawer cannot preview it. */
export function previewKind(filePath: string): PreviewKind | null {
  return fileType(filePath)?.preview ?? null
}

const BINARY_EXTS = new Set([
  ...[...IMAGE_EXTS].filter(ext => ext !== 'svg'),
  ...extensionsFor('video'),
  ...extensionsFor('audio'),
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
  return !BINARY_EXTS.has(extensionOf(baseName(filePath)))
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
