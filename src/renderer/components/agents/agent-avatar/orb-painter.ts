import type { RefObject } from 'react'
import type { AvatarOrb } from './avatar-orbs'
import { shapePath, shapePose, type OrbShape } from './orb-shapes'
import { sameFrame, type OrbFrame } from './orb-states'

type Layer = RefObject<HTMLSpanElement>
export interface OrbLayers {
  root: Layer
  body: Layer
  glow: Layer
  formWrap: Layer
  form: Layer
  face: Layer
  lid: Layer
  gradient: Layer
  highlight: Layer
  dots: Layer[]
}

type AnimatedStyle = 'transform' | 'opacity' | 'filter' | 'display' | 'width' | 'height' | 'clipPath' | 'background'

/**
 * Owns only animated styles. Recreated when appearance changes, so geometry
 * and style caches cannot survive a change of shape, size, or colourway.
 */
export function createOrbPainter(layers: OrbLayers, shape: OrbShape, diameter: number, orb: AvatarOrb) {
  const dotPaths = new Map<number, string>()
  const styles = new WeakMap<HTMLSpanElement, Map<AnimatedStyle, string>>()
  let previous: OrbFrame | null = null
  let pose: ReturnType<typeof shapePose> | undefined
  let posePhi: number | undefined
  let poseDistance: number | undefined

  function set(layer: Layer, property: AnimatedStyle, value: string) {
    const node = layer.current
    if (!node) return
    let cached = styles.get(node)
    if (!cached) {
      cached = new Map()
      styles.set(node, cached)
    }
    if (cached.get(property) === value) return
    node.style[property] = value
    cached.set(property, value)
  }

  function dotPath(size: number) {
    const key = Math.round(size * 2) / 2
    let path = dotPaths.get(key)
    if (!path) {
      path = `path('${shapePath(shape, key)}')`
      dotPaths.set(key, path)
    }
    return path
  }

  return (frame: OrbFrame) => {
    if (previous && sameFrame(previous, frame)) return
    previous = frame
    set(layers.body, 'opacity', String(frame.opacity))
    // During typing the body is invisible: only the dots need painting.
    if (frame.opacity > 0) {
      if (!pose || frame.phi !== posePhi || frame.distance !== poseDistance) {
        pose = shapePose(shape, frame, diameter, orb.hold)
        posePhi = frame.phi
        poseDistance = frame.distance
      }
      const p = pose
      set(layers.body, 'transform', `translateY(${frame.jump * diameter}px) scale(${frame.scale * frame.scaleX}, ${frame.scale * frame.scaleY})`)
      set(layers.body, 'filter', frame.saturation < 0.999 ? `saturate(${frame.saturation})` : '')
      set(layers.glow, 'opacity', String((p.shaped ? 0.3 : 1) * frame.glowOpacity))
      set(layers.glow, 'transform', `translate(${p.glowX}px, ${p.glowY}px) scale(${frame.glow})`)
      set(layers.formWrap, 'opacity', String(frame.glowOpacity))
      set(layers.form, 'transform', `translate(${p.glowX}px, ${p.glowY}px) scale(${p.formScale * frame.glow})`)
      set(layers.face, 'transform', `translate(${p.faceX}px, ${p.faceY}px) rotate(${p.faceTurn}deg) scaleY(${p.squash}) rotate(${-p.faceTurn}deg) scale(${0.5 * frame.faceScale})`)
      set(layers.face, 'opacity', String(frame.faceOpacity))
      set(layers.lid, 'transform', `scaleY(${frame.blink})`)
      set(layers.gradient, 'transform', `rotate(${p.faceTurn}deg)`)
      set(layers.highlight, 'transform', `translate(${p.highlightX}px, ${p.highlightY}px) scale(0.62)`)
    }
    layers.dots.forEach((layer, i) => {
      const dot = frame.dots[i]
      set(layer, 'display', dot ? '' : 'none')
      if (!dot) return
      // Bounce via a transform. Updating top/left would require layout every frame.
      set(layer, 'transform', `translate(${diameter / 2 + dot.x - dot.size / 2}px, ${diameter / 2 + dot.y - dot.size / 2}px)`)
      set(layer, 'width', `${dot.size}px`)
      set(layer, 'height', `${dot.size}px`)
      set(layer, 'opacity', String(dot.opacity))
      set(layer, 'clipPath', dotPath(dot.size))
      set(layer, 'background', `linear-gradient(${frame.phi + 225}deg, ${orb.faceA} 20%, ${orb.faceB} 85%)`)
    })
  }
}
