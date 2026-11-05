import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Our own radius scale (tailwind.config.ts). Without this, tailwind-merge
// doesn't see `rounded-card` etc. as a radius and a call site's `rounded-full`
// would sit beside it and lose on CSS order.
const radii = ['control', 'icon', 'item', 'popover', 'card', 'dialog']
const sides = ['', '-s', '-e', '-t', '-r', '-b', '-l', '-ss', '-se', '-ee', '-es', '-tl', '-tr', '-br', '-bl'] as const
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: Object.fromEntries(
      sides.map((side) => [`rounded${side}`, [{ [`rounded${side}`]: radii }]]),
    ),
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
