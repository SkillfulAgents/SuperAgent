import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@renderer/components/ui/alert-dialog'
import { Upload, Link2 } from 'lucide-react'

export type MountChoice = 'upload' | 'mount' | 'cancel'

interface MountChoiceDialogProps {
  open: boolean
  onChoice: (choice: MountChoice) => void
  folderName?: string
}

export function MountChoiceDialog({ open, onChoice, folderName }: MountChoiceDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onChoice('cancel') }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>How do you want to attach{folderName ? ` "${folderName}"` : ' this folder'}?</AlertDialogTitle>
          <AlertDialogDescription>
            Choose how the agent should access this folder.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3 py-2">
          <button
            type="button"
            onClick={() => onChoice('upload')}
            className="flex items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors"
          >
            <Upload className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Upload a copy</span>
                <span className="rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-2 py-0.5 text-2xs font-semibold leading-none">Read Only</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Copies files into the agent workspace. Read-only — changes won&apos;t sync back.
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => onChoice('mount')}
            className="flex items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors"
          >
            <Link2 className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Mount folder</span>
                <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-2xs font-semibold leading-none">Read &amp; Write</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Gives the agent direct read-write access. Requires a container restart if the agent is running.
              </div>
            </div>
          </button>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
