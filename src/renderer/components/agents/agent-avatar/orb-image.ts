import type { OrbAppearance } from '@shared/lib/types/agent-avatar-orbs'
import { shapePath, shapePose, type OrbShape } from '@shared/lib/types/agent-avatar-shapes'
import { restFrame } from './orb-states'

const ARTBOARD = 240
const CENTRE = ARTBOARD / 2

const n = (value: number) => Number(value.toFixed(3))
/** A transform about the artboard's centre, as CSS's default transform-origin applies it. */
const aboutCentre = (transform: string) => `translate(${CENTRE} ${CENTRE}) ${transform} translate(${-CENTRE} ${-CENTRE})`
const blur = (id: string, deviation: number) =>
  `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${deviation}"/></filter>`

/**
 * An orb at rest as a standalone SVG, for use outside the app (a Slack app's
 * icon): OrbAvatar's layers, drawn with SVG's clip paths, gradients and blurs
 * instead of styled spans, at its 240px artboard. The image is `size` px
 * square; the orb fills `fill` of it, centred, over `background`
 * (transparent without one).
 */
export function orbSvg({ orb, shape, restingPhi, size = ARTBOARD, fill = 1, background }: {
  orb: OrbAppearance
  shape: OrbShape
  /** Resting gaze direction, degrees (0 = right). */
  restingPhi: number
  size?: number
  fill?: number
  background?: string
}): string {
  const path = shapePath(shape, ARTBOARD)
  const pose = shapePose(shape, restFrame(restingPhi), ARTBOARD, orb.hold)
  const scale = (size * fill) / ARTBOARD
  const inset = (size - size * fill) / 2
  const face = `translate(${n(pose.faceX)} ${n(pose.faceY)}) rotate(${n(pose.faceTurn)}) scale(1 ${n(pose.squash)}) rotate(${n(-pose.faceTurn)}) scale(0.5)`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    '<defs>',
    `<clipPath id="outline"><path d="${path}"/></clipPath>`,
    `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${CENTRE}" cy="${CENTRE}" r="114">`,
    `<stop offset="0" stop-color="${orb.core}"/><stop offset="${orb.hold / 100}" stop-color="${orb.core}"/><stop offset="1" stop-color="${orb.core}" stop-opacity="0"/>`,
    '</radialGradient>',
    // The face's 135° gradient across a box 150% of the orb: corner to corner.
    `<linearGradient id="face" gradientUnits="userSpaceOnUse" x1="-60" y1="-60" x2="300" y2="300">`,
    `<stop offset="0.25" stop-color="${orb.faceA}"/><stop offset="0.75" stop-color="${orb.faceB}"/>`,
    '</linearGradient>',
    blur('form', 20),
    blur('highlight', 26),
    '</defs>',
    background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '',
    `<g transform="translate(${n(inset)} ${n(inset)}) scale(${n(scale)})">`,
    '<g clip-path="url(#outline)">',
    `<rect width="${ARTBOARD}" height="${ARTBOARD}" fill="${orb.rim}"/>`,
    // The core's light: a round glow on the circle, faint under form-following shading on the rest.
    `<circle cx="${CENTRE}" cy="${CENTRE}" r="114" fill="url(#glow)" opacity="${pose.shaped ? 0.3 : 1}" transform="translate(${n(pose.glowX)} ${n(pose.glowY)})"/>`,
    pose.shaped
      ? `<g filter="url(#form)"><path d="${path}" fill="${orb.core}" transform="${aboutCentre(`translate(${n(pose.glowX)} ${n(pose.glowY)}) scale(${n(pose.formScale)})`)}"/></g>`
      : '',
    `<g transform="${aboutCentre(face)}"><g clip-path="url(#outline)">`,
    `<rect x="-60" y="-60" width="360" height="360" fill="url(#face)" transform="rotate(${n(pose.faceTurn)} ${CENTRE} ${CENTRE})"/>`,
    pose.shaped
      ? `<g filter="url(#highlight)"><path d="${path}" fill="${orb.faceA}" transform="${aboutCentre(`translate(${n(pose.highlightX)} ${n(pose.highlightY)}) scale(0.62)`)}"/></g>`
      : '',
    '</g></g>',
    '</g>',
    '</g>',
    '</svg>',
  ].join('')
}

/** Rasterises an SVG to a `size` px square PNG. */
export async function svgToPng(svg: string, size: number): Promise<Blob> {
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not draw the image')
  context.drawImage(image, 0, 0, size, size)
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not draw the image')), 'image/png'))
}
