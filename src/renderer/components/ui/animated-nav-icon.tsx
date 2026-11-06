import { useEffect, useRef } from 'react'
import {
  Activity, ArrowLeft, BadgeCheck, BarChart3, Bell, Blocks, Bolt, Brain,
  Compass, createLucideIcon, Cuboid, FlaskConical, KeyRound, Layers,
  LayoutGrid, ListTodo, LogOut, Logs, Mic, Mouse, MousePointer2, Plus,
  Route, ScrollText, Search, Settings, Shield, Smartphone, Sparkle,
  Users, Workflow, type LucideIcon, type LucideProps,
} from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import './animated-nav-icon.css'

// Lucide's FolderOpen is a single outline. Split the same outline at the
// bottom-left seam so its front can hinge independently of its back.
/*
 * FolderOpen outline: Copyright (c) 2026 Lucide Icons and Contributors (ISC).
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
const FolderOpen = createLucideIcon('nav-folder-open', [
  ['path', {
    d: 'M4 20a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
    key: 'back',
  }],
  ['path', {
    d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4',
    key: 'front',
  }],
])

interface IconMotion {
  /** Omit to animate the whole SVG; otherwise target parts of the Lucide icon. */
  selector?: string
  keyframes: PropertyIndexedKeyframes
  duration?: number
  stagger?: number
}

function turn(degrees: number[], selector?: string, origin = 'center'): IconMotion {
  return {
    selector,
    keyframes: { transform: degrees.map((value) => `rotate(${value}deg)`), transformOrigin: origin },
  }
}

function move(transforms: string[], selector?: string, origin = 'center', stagger = 0): IconMotion {
  return { selector, keyframes: { transform: transforms, transformOrigin: origin }, stagger }
}

const icons = {
  bell: {
    icon: Bell,
    motion: [
      { ...turn([0, -18, 16, -12, 8, -4, 0], undefined, '50% 15%'), duration: 700 },
      move(['translateX(0)', 'translateX(2px)', 'translateX(-2px)', 'translateX(0)'], 'path:first-child'),
    ],
  },
  home: {
    icon: LayoutGrid,
    motion: [move(['scale(1)', 'scale(.7)', 'scale(1.12)', 'scale(1)'], 'rect', 'center', 65)],
  },
  todo: {
    icon: ListTodo,
    motion: [move(['scale(1)', 'scale(.5)', 'scale(1.2)', 'scale(1)'], 'path:nth-child(4)')],
  },
  brain: {
    icon: Brain,
    motion: [{ selector: 'path', keyframes: { opacity: [1, .3, 1] }, duration: 380, stagger: 45 }],
  },
  compass: {
    icon: Compass,
    motion: [turn([0, -30, 35, -10, 0], 'path')],
  },
  plus: {
    icon: Plus,
    motion: [turn([0, 90]), move(['scale(1)', 'scale(.75)', 'scale(1)'], 'path')],
  },
  settings: {
    icon: Settings,
    motion: [turn([0, -12, 60])],
  },
  back: {
    icon: ArrowLeft,
    motion: [move(['translateX(0)', 'translateX(-3px)', 'translateX(1px)', 'translateX(0)'])],
  },
  logout: {
    icon: LogOut,
    motion: [move(['translateX(0)', 'translateX(3px)', 'translateX(0)'], 'path:nth-child(-n+2)')],
  },
  general: {
    icon: Bolt,
    motion: [turn([0, 60], 'path'), move(['scale(1)', 'scale(.7)', 'scale(1)'], 'circle')],
  },
  account: {
    icon: BadgeCheck,
    motion: [move(['scale(1)', 'scale(0)', 'scale(1.2)', 'scale(1)'], 'path:last-child')],
  },
  experiments: {
    icon: FlaskConical,
    motion: [
      turn([0, -8, 8, -4, 0], undefined, '50% 85%'),
      move(['translateY(0)', 'translateY(-3px)', 'translateY(0)'], 'path:nth-child(2)'),
    ],
  },
  analytics: {
    icon: Activity,
    motion: [move(['scaleY(1)', 'scaleY(.35)', 'scaleY(1.15)', 'scaleY(1)'], 'path')],
  },
  users: {
    icon: Users,
    motion: [move(['translateY(0)', 'translateY(-2px)', 'translateY(0)'], ':scope > *', 'center', 65)],
  },
  shield: {
    icon: Shield,
    motion: [move(['scale(1, 1)', 'scale(.82, 1.08)', 'scale(1.08, .94)', 'scale(1, 1)'])],
  },
  mobile: {
    icon: Smartphone,
    motion: [{ ...turn([0, -7, 7, -7, 7, 0]), duration: 450 }],
  },
  connections: {
    icon: Blocks,
    motion: [move(['translate(0, 0)', 'translate(-3px, 3px)', 'translate(0, 0)'], 'rect')],
  },
  folder: {
    icon: FolderOpen,
    motion: [move(['skewX(0) scaleY(1)', 'skewX(-12deg) scaleY(.65)', 'skewX(0) scaleY(1)'], 'path:last-child', '0% 100%')],
  },
  key: {
    icon: KeyRound,
    motion: [turn([0, -35, 12, 0], undefined, '30% 30%')],
  },
  layers: {
    icon: Layers,
    motion: [
      move(['translateY(0)', 'translateY(-3px)', 'translateY(0)'], 'path:first-child'),
      move(['translateY(0)', 'translateY(2px)', 'translateY(0)'], 'path:last-child'),
    ],
  },
  search: {
    icon: Search,
    motion: [move(['translate(0, 0)', 'translate(-2px, -1px)', 'translate(1px, -2px)', 'translate(0, 0)'])],
  },
  pointer: {
    icon: MousePointer2,
    motion: [move(['translate(0, 0) scale(1)', 'translate(-2px, -2px) scale(1)', 'translate(-2px, -2px) scale(.8)', 'translate(0, 0) scale(1)'])],
  },
  mouse: {
    icon: Mouse,
    motion: [move(['translateY(0)', 'translateY(3px)', 'translateY(0)'], 'path')],
  },
  workflow: {
    icon: Workflow,
    motion: [move(['scale(1)', 'scale(.7)', 'scale(1.1)', 'scale(1)'], 'rect', 'center', 160)],
  },
  guidance: {
    icon: ScrollText,
    motion: [move(['scaleX(1)', 'scaleX(.15)', 'scaleX(1)'], 'path:nth-child(-n+2)', 'left', 90)],
  },
  sparkle: {
    icon: Sparkle,
    motion: [move(['rotate(0) scale(1)', 'rotate(45deg) scale(.65)', 'rotate(90deg) scale(1)'])],
  },
  mic: {
    icon: Mic,
    motion: [move(['scaleY(1)', 'scaleY(.8)', 'scaleY(1.08)', 'scaleY(.9)', 'scaleY(1)'], 'rect', 'bottom')],
  },
  route: {
    icon: Route,
    motion: [move(['scale(1)', 'scale(.5)', 'scale(1)'], 'circle', 'center', 220)],
  },
  runtime: {
    icon: Cuboid,
    motion: [move(['translateY(0) rotate(0)', 'translateY(-2px) rotate(-8deg)', 'translateY(0) rotate(0)'])],
  },
  usage: {
    icon: BarChart3,
    motion: [move(['scaleY(1)', 'scaleY(.3)', 'scaleY(1)'], 'path:not(:first-child)', 'bottom', 90)],
  },
  logs: {
    icon: Logs,
    motion: [{ selector: 'path:nth-last-child(-n+3)', keyframes: { opacity: [1, .2, 1], transform: ['translateX(0)', 'translateX(2px)', 'translateX(0)'] }, stagger: 90 }],
  },
} satisfies Record<string, { icon: LucideIcon; motion: IconMotion[] }>

interface AnimatedNavIconProps extends Omit<LucideProps, 'ref'> {
  name: keyof typeof icons
}

/**
 * A one-shot animation on the enclosing row's hover, keyboard focus or click.
 * Keep the original button/link in charge of navigation and focus. Animation
 * state stays on the SVG, so moving across the sidebar never re-renders it.
 */
export function AnimatedNavIcon({ name, className, ...props }: AnimatedNavIconProps) {
  const ref = useRef<SVGSVGElement>(null)
  const Icon = icons[name].icon

  useEffect(() => {
    const svg = ref.current
    const trigger = svg?.closest('button, a')
    if (!svg || !trigger || !svg.animate || !window.matchMedia) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animations: Animation[] = []
    const cancel = () => {
      animations.forEach((animation) => animation.cancel())
      animations = []
    }
    const play = () => {
      cancel()
      if (reducedMotion.matches || trigger.matches(':disabled, [aria-disabled="true"]')) return
      const motions: IconMotion[] = icons[name].motion
      for (const { selector, keyframes, duration = 560, stagger = 0 } of motions) {
        const targets = selector ? svg.querySelectorAll<SVGElement>(selector) : [svg]
        targets.forEach((target, index) => {
          animations.push(target.animate(keyframes, {
            duration,
            delay: index * stagger,
            easing: 'ease-in-out',
          }))
        })
      }
    }
    const onPointerEnter = (event: Event) => {
      if ((event as PointerEvent).pointerType !== 'touch') play()
    }
    const onFocus = () => {
      if (trigger.matches(':focus-visible')) play()
    }
    trigger.addEventListener('pointerenter', onPointerEnter)
    trigger.addEventListener('focus', onFocus)
    trigger.addEventListener('click', play)
    reducedMotion.addEventListener('change', cancel)
    return () => {
      cancel()
      trigger.removeEventListener('pointerenter', onPointerEnter)
      trigger.removeEventListener('focus', onFocus)
      trigger.removeEventListener('click', play)
      reducedMotion.removeEventListener('change', cancel)
    }
  }, [name])

  return <Icon ref={ref} aria-hidden="true" className={cn('animated-nav-icon', className)} {...props} />
}
