import { useMemo } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { AvatarOrb } from './avatar-orbs'
import { shapePath, type OrbShape } from './orb-shapes'
import type { OrbState } from './orb-states'
import { useOrbAnimation } from './use-orb-animation'

export type AvatarMotionState = OrbState
const ARTBOARD = 240

/**
 * An agent orb in any of the orb shapes, built from the design's layers: the
 * rim-coloured body, the core's glow (a round radial glow on the circle,
 * blurred form-following shading on the other shapes), and the face — a
 * half-size copy of the body that slides toward the edge it looks at.
 *
 * Every state is a frame function of time (orb-states.ts), driven while
 * visible from one shared frame loop and written to the layers' styles, so motion
 * costs no React render. Changes of state blend over 0.45s; leaving
 * "working" first plays the dots' gather and regrow. `followPointer` tracks
 * the cursor while idle or done — `true` anywhere, or a selector for an
 * ancestor region — and hands back to the state when it leaves. Reduced
 * motion holds a still frame per state.
 */
export function OrbAvatar({
  orb,
  shape,
  diameter,
  restingPhi,
  state = 'idle',
  followPointer = false,
  className,
}: {
  orb: AvatarOrb
  shape: OrbShape
  diameter: number
  /** Resting gaze direction, degrees (0 = right). */
  restingPhi: number
  state?: AvatarMotionState
  followPointer?: boolean | string
  className?: string
}) {
  const layers = useOrbAnimation({ orb, shape, diameter, restingPhi, state, followPointer })
  const scale = diameter / ARTBOARD
  const shaped = shape.name !== 'circle'
  const path = useMemo(() => `path('${shapePath(shape, diameter)}')`, [shape, diameter])

  return (
    <span
      ref={layers.root}
      aria-hidden="true"
      data-avatar-orb={orb.name}
      data-avatar-shape={shape.name}
      className={cn('relative block shrink-0', className)}
      style={{ width: diameter, height: diameter }}
    >
      <span
        ref={layers.body}
        className="absolute inset-0 overflow-hidden"
        style={{
          clipPath: path,
          background: orb.rim,
          isolation: 'isolate',
          transformOrigin: '50% 88%',
        }}
      >
        <span
          ref={layers.glow}
          data-orb-layer="glow"
          className="absolute rounded-full"
          style={{
            left: 6 * scale,
            top: 6 * scale,
            width: 228 * scale,
            height: 228 * scale,
            background: `radial-gradient(circle closest-side, ${orb.core} 0%, ${orb.core} ${orb.hold}%, ${orb.core}00 100%)`,
          }}
        />
        {shaped && (
          <span ref={layers.formWrap} className="absolute inset-0" style={{ filter: `blur(${20 * scale}px)` }}>
            <span
              ref={layers.form}
              className="absolute inset-0"
              style={{
                clipPath: path,
                background: orb.core,
              }}
            />
          </span>
        )}
        <span
          ref={layers.face}
          data-orb-layer="face"
          className="absolute inset-0"
        >
          <span ref={layers.lid} className="absolute inset-0 overflow-hidden" style={{ clipPath: path }}>
            <span
              ref={layers.gradient}
              className="absolute"
              style={{
                left: '-25%',
                top: '-25%',
                width: '150%',
                height: '150%',
                background: `linear-gradient(135deg, ${orb.faceA} 25%, ${orb.faceB} 75%)`,
              }}
            />
            {shaped && (
              <span className="absolute inset-0" style={{ filter: `blur(${26 * scale}px)` }}>
                <span
                  ref={layers.highlight}
                  className="absolute inset-0"
                  style={{
                    clipPath: path,
                    background: orb.faceA,
                  }}
                />
              </span>
            )}
          </span>
        </span>
      </span>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          ref={layers.dots[i]}
          data-orb-layer="dot"
          className="absolute"
          style={{ display: 'none', left: 0, top: 0 }}
        />
      ))}
    </span>
  )
}
