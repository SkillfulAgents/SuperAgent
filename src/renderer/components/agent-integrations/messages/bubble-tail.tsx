import { cn } from '@shared/lib/utils/cn'

/**
 * The curled tail on a chat bubble's bottom-right corner, filled with
 * currentColor. It squares off the bubble's rounded corner and sweeps out past
 * its edge, so give the bubble `relative` and set the tail's text color to the
 * bubble's background.
 */
export function BubbleTail({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 26 22"
      className={cn('pointer-events-none absolute -right-[8px] bottom-0 h-[22px] w-[26px]', className)}
    >
      <path d="M0 0H18V8C18 14.5 21 19.2 26 21.6C20 22.6 14.6 21.4 11.2 18.8C8.6 21 5.4 22 2.2 22H0Z" fill="currentColor" />
    </svg>
  )
}
