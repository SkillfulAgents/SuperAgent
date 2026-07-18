const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  env: 'text/plain',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  return (ext && MIME_MAP[ext]) || 'application/octet-stream'
}

export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || ''
}
