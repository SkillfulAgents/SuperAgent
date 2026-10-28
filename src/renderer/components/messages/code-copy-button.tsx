import { useCallback, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

/** Hover-revealed copy control; the parent must be `relative group`. */
export function CodeCopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(getText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [getText])

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'absolute top-2 right-2 p-1 rounded',
        'opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity',
        'hover:bg-black/[0.1] dark:hover:bg-white/[0.15]',
        'text-muted-foreground'
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}
