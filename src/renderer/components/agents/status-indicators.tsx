export function WorkingDots({ dotClassName = 'bg-green-500' }: { dotClassName?: string } = {}) {
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" role="img" aria-label="working">
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.15s] ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.3s] ${dotClassName}`} />
    </span>
  )
}

export function AwaitingDot(_props: { size?: 'sm' | 'default' } = {}) {
  // Outer span is 12px so the ping (scales 2× from 6px → 12px) has room
  // without being clipped by the parent row's `overflow-hidden`.
  return (
    <span className="relative flex items-center justify-center shrink-0 h-3 w-3" role="img" aria-label="needs input">
      <span className="animate-ping absolute inline-flex h-1.5 w-1.5 rounded-full bg-orange-500 opacity-75" />
      <span className="relative inline-flex rounded-full bg-orange-500 h-1.5 w-1.5" />
    </span>
  )
}
