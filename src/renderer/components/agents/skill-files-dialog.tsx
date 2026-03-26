import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { CodeEditor } from '@renderer/components/ui/code-editor'
import { FileTree, buildFileTree } from '@renderer/components/ui/file-tree'
import { useSkillFiles, useSkillFileContent, useSaveSkillFile } from '@renderer/hooks/use-skill-files'

const NAV_MIN_WIDTH = 140
const NAV_MAX_WIDTH = 400
const NAV_DEFAULT_WIDTH = 224

interface SkillFilesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  skillDir: string
  skillName: string
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    md: 'markdown',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    html: 'html',
    css: 'css',
    py: 'python',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    txt: 'plaintext',
    xml: 'xml',
    sql: 'sql',
    toml: 'ini',
  }
  return map[ext ?? ''] ?? 'plaintext'
}

export function SkillFilesDialog({
  open,
  onOpenChange,
  agentSlug,
  skillDir,
  skillName,
}: SkillFilesDialogProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [localContent, setLocalContent] = useState<string>('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [navWidth, setNavWidth] = useState(NAV_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedContentRef = useRef<string>('')

  const { data: files, isLoading: filesLoading } = useSkillFiles(
    open ? agentSlug : null,
    open ? skillDir : null,
  )
  const { data: fileContent, isLoading: contentLoading } = useSkillFileContent(
    open ? agentSlug : null,
    open ? skillDir : null,
    selectedPath,
  )
  const saveFile = useSaveSkillFile()

  const tree = useMemo(() => (files ? buildFileTree(files) : []), [files])

  // Sync fetched content to local state
  useEffect(() => {
    if (fileContent !== undefined) {
      setLocalContent(fileContent)
      lastSavedContentRef.current = fileContent
      setSaveStatus('idle')
    }
  }, [fileContent])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedPath(null)
      setLocalContent('')
      setSaveStatus('idle')
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
    }
  }, [open])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  const handleContentChange = useCallback(
    (value: string) => {
      setLocalContent(value)

      if (!selectedPath) return

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      const currentPath = selectedPath
      saveTimeoutRef.current = setTimeout(() => {
        if (value === lastSavedContentRef.current) return
        setSaveStatus('saving')
        saveFile.mutate(
          { agentSlug, skillDir, filePath: currentPath, content: value },
          {
            onSuccess: () => {
              lastSavedContentRef.current = value
              setSaveStatus('saved')
              setTimeout(() => setSaveStatus('idle'), 1500)
            },
            onError: () => {
              setSaveStatus('idle')
            },
          },
        )
      }, 500)
    },
    [selectedPath, agentSlug, skillDir, saveFile],
  )

  const handleSelectFile = useCallback((filePath: string) => {
    // Flush pending save before switching
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    setSelectedPath(filePath)
    setSaveStatus('idle')
  }, [])

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = navWidth
      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX
        setNavWidth(Math.min(NAV_MAX_WIDTH, Math.max(NAV_MIN_WIDTH, startWidth + dx)))
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setIsResizing(false)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [navWidth],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[900px]">
        <DialogTitle className="sr-only">Files — {skillName}</DialogTitle>
        <DialogDescription className="sr-only">
          Browse and edit skill files
        </DialogDescription>
        <div className="flex items-start min-h-0 h-[480px]">
          {/* File tree nav */}
          <div
            className="hidden md:flex h-full flex-col bg-sidebar text-sidebar-foreground shrink-0 overflow-hidden"
            style={{ width: navWidth, transition: isResizing ? 'none' : 'width 0.2s ease-linear' }}
          >
            {filesLoading ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <FileTree
                entries={tree}
                selectedPath={selectedPath}
                onSelectFile={handleSelectFile}
                className="h-full"
              />
            )}
          </div>
          {/* Resize handle */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className="hidden md:flex h-full w-1 shrink-0 cursor-col-resize flex-col hover:bg-sidebar-border active:bg-sidebar-border transition-colors relative"
            onMouseDown={handleResizeStart}
          >
            <div className="h-12 shrink-0 border-b" />
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
          {/* Main content */}
          <main className="flex flex-1 flex-col overflow-hidden h-full min-w-0">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 pr-12">
              <span className="text-sm text-muted-foreground">{skillName}</span>
              {selectedPath && (
                <>
                  <span className="text-sm text-muted-foreground">/</span>
                  <span className="text-sm font-medium truncate">{selectedPath}</span>
                </>
              )}
              {saveStatus === 'saving' && (
                <span className="text-xs text-muted-foreground ml-auto">Saving...</span>
              )}
              {saveStatus === 'saved' && (
                <span className="text-xs text-muted-foreground ml-auto">Saved</span>
              )}
            </header>
            <div className="flex-1 overflow-hidden">
              {!selectedPath ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Select a file to view
                </div>
              ) : contentLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <CodeEditor
                  value={localContent}
                  onChange={handleContentChange}
                  language={getLanguageFromPath(selectedPath)}
                  className="h-full"
                />
              )}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}
