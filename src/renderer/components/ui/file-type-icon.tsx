import { FileIcon, defaultStyles } from 'react-file-icon'

interface FileTypeIconProps {
  filename: string
  size?: number
}

function getExtension(filename: string): string {
  const parts = filename.split('.')
  if (parts.length < 2) return ''
  return parts.pop()!.toLowerCase()
}

export function FileTypeIcon({ filename, size = 16 }: FileTypeIconProps) {
  const ext = getExtension(filename)
  const styles = (defaultStyles as Record<string, object>)[ext] ?? {}

  return (
    <div style={{ width: size }} className="shrink-0 self-center">
      <FileIcon extension={ext} {...styles} />
    </div>
  )
}
