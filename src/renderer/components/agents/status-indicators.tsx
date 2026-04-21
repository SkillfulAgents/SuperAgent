export function WorkingDots({ dotClassName = 'bg-green-500' }: { dotClassName?: string } = {}) {
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" role="img" aria-label="working">
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.15s] ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.3s] ${dotClassName}`} />
    </span>
  )
}

export function AwaitingDot({ size = 'sm' }: { size?: 'sm' | 'default' }) {
  const dim = size === 'default' ? 'h-2 w-2' : 'h-1.5 w-1.5'
  return (
    <span className={`relative flex shrink-0 ${dim}`} role="img" aria-label="needs input">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-500 opacity-75" />
      <span className={`relative inline-flex rounded-full bg-orange-500 ${dim}`} />
    </span>
  )
}
