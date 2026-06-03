interface CommentPinProps {
  x: number
  y: number
  number: number
}

export function CommentPin({ x, y, number }: CommentPinProps) {
  return (
    <div
      className="absolute w-5 h-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center shadow-md border-2 border-background pointer-events-none"
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      {number}
    </div>
  )
}
