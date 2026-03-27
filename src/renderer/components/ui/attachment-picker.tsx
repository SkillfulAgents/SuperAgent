import { useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Plus, FileIcon, FolderOpen } from 'lucide-react'

interface AttachmentPickerProps {
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  disabled?: boolean
  buttonClassName?: string
  popoverAlign?: 'start' | 'center' | 'end'
}

export function AttachmentPicker({
  onFileSelect,
  onFolderSelect,
  disabled,
  buttonClassName = 'h-[34px] px-3',
  popoverAlign = 'start',
}: AttachmentPickerProps) {
  const [open, setOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileSelect}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={onFolderSelect}
        {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className={buttonClassName}
            disabled={disabled}
            title="Add files"
          >
            <Plus className="mr-1 h-4 w-4" />
            Add files
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align={popoverAlign} className="w-40 p-1">
          <button
            type="button"
            className="flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => { setOpen(false); fileInputRef.current?.click() }}
          >
            <FileIcon className="h-4 w-4" />
            Files
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => { setOpen(false); folderInputRef.current?.click() }}
          >
            <FolderOpen className="h-4 w-4" />
            Folder
          </button>
        </PopoverContent>
      </Popover>
    </>
  )
}
