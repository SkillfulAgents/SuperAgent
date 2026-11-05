import { useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import type { ApiSkillFileEntry } from '@shared/lib/types/api'

export interface FileTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeEntry[]
}

interface FileTreeProps {
  entries: FileTreeEntry[]
  selectedPath: string | null
  onSelectFile: (path: string) => void
  className?: string
}

export function buildFileTree(flatFiles: ApiSkillFileEntry[]): FileTreeEntry[] {
  const root: FileTreeEntry[] = []
  const dirMap = new Map<string, FileTreeEntry>()

  // Sort so directories come first, then alphabetical
  const sorted = [...flatFiles].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  for (const entry of sorted) {
    const parts = entry.path.split('/')
    const name = parts[parts.length - 1]
    const node: FileTreeEntry = { name, path: entry.path, type: entry.type }

    if (entry.type === 'directory') {
      node.children = []
      dirMap.set(entry.path, node)
    }

    if (parts.length === 1) {
      root.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = dirMap.get(parentPath)
      if (parent?.children) {
        parent.children.push(node)
      } else {
        root.push(node)
      }
    }
  }

  return root
}

export function FileTree({ entries, selectedPath, onSelectFile, className }: FileTreeProps) {
  return (
    <ScrollArea className={className}>
      <div className="py-2 px-1">
        {entries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

interface FileTreeNodeProps {
  entry: FileTreeEntry
  depth: number
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

function FileTreeNode({ entry, depth, selectedPath, onSelectFile }: FileTreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth === 0)

  if (entry.type === 'directory') {
    return (
      <div>
        <button
          className={cn(
            'flex items-center gap-1 w-full text-left py-1 px-1.5 rounded-item text-sm hover:bg-accent transition-colors',
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={() => setIsOpen(!isOpen)}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              isOpen && 'rotate-90'
            )}
          />
          {isOpen ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        {isOpen && entry.children?.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      className={cn(
        'flex items-center gap-1 w-full text-left py-1 px-1.5 rounded-item text-sm hover:bg-accent transition-colors',
        selectedPath === entry.path && 'bg-accent'
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={() => onSelectFile(entry.path)}
    >
      <File className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
