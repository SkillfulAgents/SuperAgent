import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

const RADIUS = 10
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

interface DonutChartProps {
  /** Percentage value (0–100+) */
  percent: number
  /** Tooltip text */
  tooltip?: string
  /** Whether to show a pulse animation */
  animated?: boolean
  /** Color thresholds: [warningAt, criticalAt]. Defaults to [50, 70]. */
  thresholds?: [number, number]
  /** Size of the chart. Defaults to 'default'. */
  size?: 'sm' | 'default'
  /** Whether to show the percentage number inside the donut. Defaults to true. */
  showLabel?: boolean
}

export function DonutChart({
  percent,
  tooltip,
  animated,
  thresholds = [50, 70],
  size = 'default',
  showLabel = true,
}: DonutChartProps) {
  const [warning, critical] = thresholds
  const clamped = Math.min(percent, 100)

  const strokeClass = percent >= critical
    ? 'stroke-destructive'
    : percent >= warning
      ? 'stroke-yellow-500'
      : 'stroke-primary'

  const textClass = percent >= critical
    ? 'text-destructive'
    : percent >= warning
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-muted-foreground'

  const buttonSize = size === 'sm' ? 'h-6 w-6' : 'h-9 w-9'
  const svgSize = size === 'sm' ? 'h-5 w-5' : 'h-8 w-8'

  const chart = (
    <div
      className={`relative ${buttonSize} flex items-center justify-center ${animated ? 'animate-pulse' : ''}`}
    >
      <svg className={`${svgSize} -rotate-90`} viewBox="0 0 28 28">
        <circle
          cx="14" cy="14" r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-muted"
        />
        <circle
          cx="14" cy="14" r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
          strokeLinecap="round"
          className={`transition-all duration-500 ${strokeClass}`}
        />
      </svg>
      {showLabel && (
        <span className={`absolute inset-0 flex items-center justify-center text-2xs font-medium tabular-nums ${textClass}`}>
          {percent}
        </span>
      )}
    </div>
  )

  if (!tooltip) return chart

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {chart}
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
