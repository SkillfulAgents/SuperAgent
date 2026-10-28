import { AlertCircle, X } from 'lucide-react'

export function UploadError({ error, onDismiss, className }: { error: string | null; onDismiss?: () => void; className?: string }) {
  if (!error) return null
  return (
    <div className={`flex items-center gap-1.5 text-xs text-destructive ${className ?? ''}`}>
      <AlertCircle className="h-3 w-3 shrink-0" />
      <span>{error}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="ml-auto shrink-0 hover:opacity-70" aria-label="Dismiss">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
